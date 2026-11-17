// ── THE AGENT: ONE TURN ───────────────────────────────────────────────────────────────
// route (code) → prompt + allowed tools for that stage → tool-calling loop → reply.

import OpenAI from "openai";
import { BUSINESS, MENU } from "./menu.js";
import { pickAgent } from "./order.js";
import { PROMPTS } from "./prompts.js";
import { makeToolExecutor, toolDefinitions } from "./tools.js";

export const MAX_ROUNDS = 4;
const HISTORY_LIMIT = 20; // messages kept per session

// ── The model call is an injected function, so the loop is testable with a fake ───────
export function createOpenAICaller({ apiKey, model, baseURL, timeoutMs = 30_000 }) {
  const client = new OpenAI({ apiKey, baseURL, timeout: timeoutMs, maxRetries: 2 });
  return async (messages, tools, { noTools = false, forceTool } = {}) => {
    const body = { model, temperature: 0.1, messages };
    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = noTools ? "none" : forceTool ? { type: "function", function: { name: forceTool } } : "auto";
    }
    const res = await client.chat.completions.create(body);
    const message = res.choices?.[0]?.message;
    if (!message) throw new Error("OpenAI response without message");
    return { message, usage: res.usage };
  };
}

// ── Tool-calling loop ─────────────────────────────────────────────────────────────────
export async function converseWithTools({ callModel, messages, tools, execute, forceFirst }) {
  const convo = [...messages];
  const toolsUsed = [];
  let rounds = 0;

  const finish = (content) => {
    const text = (content ?? "").trim();
    if (!text) throw new Error("The model returned no text");
    return { text, toolsUsed, rounds };
  };

  while (rounds < MAX_ROUNDS) {
    rounds++;
    // First round can force a tool: order agents must read the real menu before answering.
    const forceTool = rounds === 1 && forceFirst && tools.some((t) => t.function.name === forceFirst) ? forceFirst : undefined;
    const { message } = await callModel(convo, tools, { forceTool });
    const calls = message.tool_calls ?? [];
    if (calls.length === 0) return finish(message.content);

    convo.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });
    for (const call of calls) {
      toolsUsed.push(call.function.name);
      let output;
      try {
        output = await execute(call.function.name, call.function.arguments);
      } catch (e) {
        output = `Tool error: ${e.message}`; // the model answers with what it has
      }
      convo.push({ role: "tool", tool_call_id: call.id, content: output });
    }
  }

  // Too many rounds: one last call where tools are visible but disallowed.
  rounds++;
  const { message } = await callModel(convo, tools, { noTools: true });
  return finish(message.content);
}

// ── Session store (in memory; production keeps this in a database) ────────────────────
export function createSessionStore() {
  const sessions = new Map();
  return {
    get(id) {
      if (!sessions.has(id)) sessions.set(id, { order: null, history: [] });
      return sessions.get(id);
    },
    reset(id) {
      sessions.delete(id);
    },
  };
}

// ── One customer message → one reply ──────────────────────────────────────────────────
export async function handleMessage({ store, sessionId, text, callModel }) {
  const session = store.get(sessionId);

  // 1. Routing is decided by code from the persisted order, never by the model.
  const route = pickAgent(session.order);

  // 2. Prompt + only the tools this stage is allowed to use.
  const tools = toolDefinitions(route.agent);
  const execute = makeToolExecutor({
    session,
    menu: MENU,
    info: BUSINESS.info,
    allowed: tools.map((t) => t.function.name),
  });
  const messages = [{ role: "system", content: PROMPTS[route.agent] }, ...session.history, { role: "user", content: text }];

  // 3. Model + tools. The agents that build the order must read the menu first.
  const result = await converseWithTools({
    callModel,
    messages,
    tools,
    execute,
    forceFirst: route.agent === "orchestrator" || route.agent === "collector" ? "get_menu" : undefined,
  });

  // 4. Keep a bounded history of plain user/assistant text (tool traffic is not replayed).
  session.history.push({ role: "user", content: text }, { role: "assistant", content: result.text });
  if (session.history.length > HISTORY_LIMIT) session.history.splice(0, session.history.length - HISTORY_LIMIT);

  return { reply: result.text, agent: route.agent, reason: route.reason, toolsUsed: result.toolsUsed, order: session.order };
}
