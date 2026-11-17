// EXCERPT 04 — One turn, end to end (orchestration and guard rails).
//
// What this shows: the order of operations of a single conversational turn and where the code
// refuses to trust the model.
//   · Everything that touches the network or the DB arrives through `Deps`, so the whole pipeline is
//     tested with fake dependencies.
//   · Cheap deterministic filters run BEFORE any model call (service off, ignored number, human
//     takeover, unsupported message types).
//   · Idempotency: if the function died between sending and closing, `alreadyAnswered` stops a
//     duplicate reply.
//   · Guard rails that do not depend on the prompt: a closed restaurant cannot start an order even
//     if the model emits one; unknown products are dropped; the service gate is re-checked before
//     every write and before every send (the owner can pause the service mid-turn).
//   · Side effects are saved BEFORE sending, and are idempotent, so a retry after a failed send
//     rewrites the same data instead of duplicating it.
// Source: the turn module of the production turn handler (heavily trimmed; identifiers translated;
// error classes, the voice/image step, owner-chat fee detection and payment-proof handling omitted).

import { pickAgent, type Agent, type SavedOrder } from "./01-stage-routing.ts";
import { converseWithTools, type CallModel, type ChatMessage } from "./02-tools-and-agent-loop.ts";
import { parseOrderOutput, reconcileWithMenu, type Menu } from "./03-output-validation.ts";

export type Turn = { id: string; conversationId: string; messageIds: string[]; attempt: number };
export type TurnResult = { status: "ok" | "skipped" | "error"; agent?: string; note?: string; replyMessageId?: string };

export type Deps = {
  now(): Date;
  load(turn: Turn): Promise<{
    business: { id: string; active: boolean };
    conversation: { humanUntil: string | null; intent: string | null; intentUntil: string | null };
    customer: { phone: string | null };
    ignoredPhones: string[];
    text: string;
  }>;
  serviceEnabled(businessId: string): Promise<boolean>;
  alreadyAnswered(turn: Turn): Promise<boolean>;
  businessStatus(businessId: string): Promise<"open" | "before_opening" | "already_closed">;
  openOrder(conversationId: string): Promise<SavedOrder | null>;
  menu(): Promise<Menu>;
  prompt(agent: Agent): Promise<string>;
  history(conversationId: string): Promise<ChatMessage[]>;
  callModel: CallModel;
  saveIntent(conversationId: string, intent: string, until: Date): Promise<void>;
  saveDraft(conversationId: string, draft: unknown): Promise<void>;
  sendText(to: string, text: string): Promise<{ messageId: string }>;
};

const INTENT_TTL_MS = 60 * 60 * 1000;
const skipped = (why: string, note?: string): TurnResult => ({ status: "skipped", agent: why, note });

class ServiceOff extends Error {}
async function requireService(d: Deps, businessId: string) {
  if (!(await d.serviceEnabled(businessId))) throw new ServiceOff("Service paused");
}

export async function processTurn(turn: Turn, d: Deps): Promise<TurnResult> {
  try {
    return await run(turn, d);
  } catch (e) {
    if (e instanceof ServiceOff) return skipped("service_unavailable");
    // never throw out of here: the caller always closes the turn, and errors are retried with backoff
    return { status: "error", note: String((e as Error).message).slice(0, 300) };
  }
}

async function run(turn: Turn, d: Deps): Promise<TurnResult> {
  const now = d.now();
  const data = await d.load(turn);
  const { business, conversation, customer } = data;

  await requireService(d, business.id);
  if (await d.alreadyAnswered(turn)) return skipped("already_answered");

  // ── deterministic filters: decided without spending a model call ──────────────────
  if (!business.active) return skipped("business_off");
  if (customer.phone && data.ignoredPhones.includes(customer.phone)) return skipped("ignored_number");
  if (conversation.humanUntil && new Date(conversation.humanUntil) > now) return skipped("human_takeover");
  if (!customer.phone) return skipped("no_reply_address");
  if (data.text === "") return skipped("no_content");

  // ── routing: from persisted state, never from the model ───────────────────────────
  const status = await d.businessStatus(business.id);
  const intentValid = conversation.intent && conversation.intentUntil && new Date(conversation.intentUntil) > now;
  const activeIntent = intentValid ? conversation.intent : null;
  const order = activeIntent === "order" ? await d.openOrder(turn.conversationId) : null;
  const route = pickAgent({ businessStatus: status, activeIntent, order });
  const isOrderAgent = route.agent !== "intent" && route.agent !== "closed_hours";

  // ── prompt + model with tools ─────────────────────────────────────────────────────
  const menu = await d.menu();
  const messages: ChatMessage[] = [
    { role: "system", content: await d.prompt(route.agent) },
    ...(await d.history(turn.conversationId)),
    { role: "user", content: data.text },
  ];
  const convo = await converseWithTools({
    callModel: d.callModel,
    messages,
    tools: [], // tool definitions for route.agent (see 02-tools-and-agent-loop.ts)
    execute: async () => "",
    // the agents that build the order must read the real menu on the first round
    forceFirst: route.agent === "orchestrator" || route.agent === "collector" ? "menu" : undefined,
  });

  // ── apply what the model said, with code in charge ────────────────────────────────
  const notes: string[] = [];
  const parsed = parseOrderOutput(convo.text, { customerPhone: customer.phone });
  notes.push(...parsed.errors);

  if (isOrderAgent && parsed.draft) {
    const { items, warnings } = reconcileWithMenu(parsed.draft.items, menu);
    notes.push(...warnings);
    const valid = items.filter((i) => i.inMenu); // what is not on the menu is not saved
    await requireService(d, business.id);
    if (valid.length > 0) await d.saveDraft(turn.conversationId, { ...parsed.draft, items: valid });
    await d.saveIntent(turn.conversationId, "order", new Date(now.getTime() + INTENT_TTL_MS));
  } else if (route.agent === "closed_hours" && parsed.draft) {
    // the prompt forbids taking orders while closed, but the code does not depend on the model obeying
    notes.push("order_ignored_restaurant_closed");
  }

  await requireService(d, business.id);
  const sent = await d.sendText(customer.phone, parsed.reply);
  return { status: "ok", agent: route.agent, note: notes.join("; ").slice(0, 300) || undefined, replyMessageId: sent.messageId };
}
