// EXCERPT 02 — Tool (function calling) definitions, per-agent allowlists, and the tool-calling loop.
//
// What this shows (two parts that always travel together):
//   A. Tools are declared once, each agent only receives the tools its stage needs, and the executor
//      is a single switch that takes its I/O as injected functions (testable without network).
//      Unknown tool names return an error string instead of throwing. In production the tools are
//      read-only lookups; order mutations are NOT tools — they come back as parsed output
//      (see 03-output-validation.ts) and are applied by code.
//   B. A hand-written loop against the OpenAI Chat Completions API (it replaced the "AI Agent" node
//      of the original n8n workflow):
//        1. the model call is an injected function, so the loop is tested with a fake model;
//        2. the first round can FORCE a tool (order agents must read the real menu before answering;
//           without this the model sometimes invented products from memory);
//        3. a failing tool never kills the turn: the model receives the error text and answers with
//           what it has; after MAX_ROUNDS it gets one last call with tool_choice = "none".
// Source: the tools, model-loop and OpenAI-client modules of the production turn handler (trimmed,
// identifiers translated from Spanish). Omitted: schedule-formatting helpers, the real (longer) tool
// descriptions, the catalog serializer, and the audio/image helpers.

// ── A. Tools ─────────────────────────────────────────────────────────────────────
export type ToolName = "business_info" | "menu" | "send_menu_pdf" | "get_hours";

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: { type: "object"; properties: Record<string, never> };
  };
};

const DESCRIPTIONS: Record<ToolName, string> = {
  business_info: "General restaurant information: location, payment methods, delivery, policies, FAQ.",
  menu: "The current menu with categories and official prices. Always call it before quoting a price.",
  send_menu_pdf: "Sends the menu PDF to the customer. Use when they ask for the menu in general.",
  get_hours: "Opening hours, day by day, including holidays and special days.",
};

/**
 * Which tools each agent can use. The agents that build the order always have `menu`;
 * none of the order agents can send the PDF (they are mid-order, not browsing).
 */
export const TOOLS_BY_AGENT: Record<string, ToolName[]> = {
  intent: ["business_info", "menu", "send_menu_pdf"],
  closed_hours: ["get_hours", "business_info", "send_menu_pdf", "menu"],
  orchestrator: ["business_info", "menu"],
  collector: ["get_hours", "business_info", "menu"],
  // …the final-stage agents all get ["business_info", "menu"]
};

export function toolDefinitions(names: ToolName[]): ToolDefinition[] {
  return names.map((name) => ({
    type: "function" as const,
    function: { name, description: DESCRIPTIONS[name], parameters: { type: "object" as const, properties: {} } },
  }));
}

export type ToolContext = {
  infoText: string | null;
  menu: () => Promise<unknown>;
  hours: () => Promise<unknown>;
  /** Sends the PDF through the WhatsApp API and returns what the model is told ("Menu sent."). */
  sendPdf: () => Promise<string>;
};

export function makeToolExecutor(ctx: ToolContext) {
  return async (name: string): Promise<string> => {
    switch (name) {
      case "business_info":
        return ctx.infoText ?? "No restaurant information loaded.";
      case "menu":
        return JSON.stringify(await ctx.menu());
      case "get_hours":
        return JSON.stringify(await ctx.hours());
      case "send_menu_pdf":
        return await ctx.sendPdf();
      default:
        return `Unknown tool: ${name}`;
    }
  };
}


// ── B. The loop ──────────────────────────────────────────────────────────────────
export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

export type CallModel = (
  messages: ChatMessage[],
  tools: unknown[],
  opts: { noTools: boolean; forceTool?: string },
) => Promise<{ message: { content: string | null; tool_calls?: ToolCall[] }; tokensIn: number; tokensOut: number }>;

export const MAX_ROUNDS = 4;

export async function converseWithTools(p: {
  callModel: CallModel;
  messages: ChatMessage[];
  tools: { function: { name: string } }[];
  execute: (name: string, args: string) => Promise<string>;
  forceFirst?: string;
}) {
  const messages = [...p.messages];
  const used: string[] = [];
  let tokensIn = 0, tokensOut = 0, rounds = 0;

  const finish = (content: string | null) => {
    const text = (content ?? "").trim();
    if (!text) throw new Error("The model returned no text");
    return { text, tokensIn, tokensOut, rounds, toolsUsed: used };
  };

  while (rounds < MAX_ROUNDS) {
    rounds++;
    const force = rounds === 1 && p.forceFirst && p.tools.some((t) => t.function.name === p.forceFirst)
      ? p.forceFirst
      : undefined;
    const r = await p.callModel(messages, p.tools, { noTools: false, ...(force ? { forceTool: force } : {}) });
    tokensIn += r.tokensIn;
    tokensOut += r.tokensOut;
    const calls = r.message.tool_calls ?? [];
    if (calls.length === 0) return finish(r.message.content);

    messages.push({ role: "assistant", content: r.message.content ?? null, tool_calls: calls });
    for (const call of calls) {
      used.push(call.function.name);
      let output: string;
      try {
        output = await p.execute(call.function.name, call.function.arguments);
      } catch (e) {
        output = `Tool error: ${(e as Error).message}`; // the model answers with what it has
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: output });
    }
  }

  // Too many rounds: one last call where tools are visible (history mentions them) but disallowed.
  rounds++;
  const last = await p.callModel(messages, p.tools, { noTools: true });
  tokensIn += last.tokensIn;
  tokensOut += last.tokensOut;
  return finish(last.message.content);
}

// ── The OpenAI call: explicit timeout, explicit error type, fixed low temperature ─────
export function createCallModel(cfg: { apiKey: string; model: string; timeoutMs: number }): CallModel {
  return async (messages, tools, opts) => {
    const body: Record<string, unknown> = { model: cfg.model, temperature: 0.1, messages };
    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = opts.noTools
        ? "none"
        : opts.forceTool
        ? { type: "function", function: { name: opts.forceTool } }
        : "auto";
    }
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) {
      const detail = await res.json().then((j) => j?.error?.message as string | undefined).catch(() => undefined);
      throw new Error(`OpenAI chat ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }
    const j = await res.json();
    const m = j.choices?.[0]?.message;
    if (!m) throw new Error("OpenAI chat: response without message");
    return {
      message: { content: m.content ?? null, tool_calls: m.tool_calls ?? undefined },
      tokensIn: j.usage?.prompt_tokens ?? 0,
      tokensOut: j.usage?.completion_tokens ?? 0,
    };
  };
}
