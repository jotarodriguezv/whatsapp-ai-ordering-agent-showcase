// EXCERPT 06 — The serverless entrypoint: authenticate, claim, answer fast, work in background.
//
// What this shows: the handler is invoked by a database scheduler (pg_cron) only when there is a
// ready turn. It authenticates the caller with a shared secret, claims a bounded batch, returns
// HTTP 200 immediately, and processes the batch in the background in small concurrent groups.
// The turn is ALWAYS closed, even on unexpected exceptions; if closing fails, the DB lease expires
// and the turn is retried.
// Source: the entrypoint of the production Edge Function (Deno; trimmed, identifiers translated).
// Omitted: dependency wiring (OpenAI, Graph API sender, prompt loader, vault token lookup).
// Note on webhook security: Meta's inbound webhook signature is verified in a separate shared
// platform layer that writes messages to the database; it is not part of this service, which only
// reads those stored events. This service is protected by the secret check below.

declare const Deno: { serve(h: (req: Request) => Promise<Response> | Response): void };
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

type Turn = { id: string };
type Result = { status: "ok" | "skipped" | "error"; note?: string };

declare const data: {
  validateSecret(value: string): Promise<boolean>;   // RPC to the vault-backed SQL function
  claimTurns(limit: number): Promise<Turn[]>;         // RPC: atomic claim (see 05-turn-claiming.sql)
  closeTurn(id: string, r: Result): Promise<void>;
};
declare function processTurn(t: Turn): Promise<Result>;
declare const BATCH_LIMIT: number;
declare const CONCURRENCY: number;

async function handle(turn: Turn): Promise<void> {
  let result: Result;
  try {
    result = await processTurn(turn);
  } catch (e) {
    // processTurn already catches its errors; this is for anything that escapes (never leave a turn open)
    result = { status: "error", note: String((e as Error).message).slice(0, 300) };
  }
  try {
    await data.closeTurn(turn.id, result);
  } catch (e) {
    // could not close: the lease expires by itself and the turn is retried
    console.error("Could not close turn", turn.id, (e as Error).message);
  }
}

async function handleBatch(turns: Turn[]): Promise<void> {
  for (let i = 0; i < turns.length; i += CONCURRENCY) {
    await Promise.allSettled(turns.slice(i, i + CONCURRENCY).map(handle));
  }
}

Deno.serve(async (req) => {
  // deployed without JWT (the anon key is public): only a caller holding the secret gets in
  const secret = req.headers.get("x-cron-secret");
  if (!secret || !(await data.validateSecret(secret))) return new Response("Unauthorized", { status: 401 });

  let turns: Turn[];
  try {
    turns = await data.claimTurns(BATCH_LIMIT);
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error).message).slice(0, 300) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // answer now (the model and the messaging API take seconds); the work continues in the background
  if (turns.length > 0) EdgeRuntime.waitUntil(handleBatch(turns));
  return new Response(JSON.stringify({ turns: turns.length }), { headers: { "Content-Type": "application/json" } });
});
