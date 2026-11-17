// Tests run without an API key: the model is replaced by a scripted fake, and one test runs the
// real OpenAI SDK against a local fake HTTP server.

import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { converseWithTools, createOpenAICaller, createSessionStore, handleMessage } from "../src/agent.js";
import { MENU } from "../src/menu.js";
import { missingFields, newOrder, orderTotal, pickAgent } from "../src/order.js";
import { makeToolExecutor } from "../src/tools.js";
import { reconcileItems } from "../src/validation.js";

const toolCall = (id, name, args = {}) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const say = (content) => ({ message: { content } });
const call = (...tool_calls) => ({ message: { content: null, tool_calls } });

/** A fake model that returns scripted responses in order and records what it was asked. */
function fakeModel(script) {
  const calls = [];
  const fn = async (messages, tools, opts) => {
    calls.push({ messages: structuredClone(messages), toolNames: tools.map((t) => t.function.name), opts });
    const next = script.shift();
    if (!next) throw new Error("fake model: script exhausted");
    return next;
  };
  fn.calls = calls;
  return fn;
}

// ── Routing ────────────────────────────────────────────────────────────────────────────
test("routing follows the order state, not the model", () => {
  assert.equal(pickAgent(null).agent, "orchestrator");
  assert.equal(pickAgent({ ...newOrder(), status: "confirmed" }).agent, "orchestrator");
  assert.equal(pickAgent(newOrder()).agent, "collector");
  const complete = { ...newOrder(), customerName: "Ana", delivery: "pickup", payment: "cash", items: [{ name: "Fries", quantity: 1, price: 4000 }] };
  assert.equal(pickAgent(complete).agent, "finalizer");
  assert.deepEqual(missingFields({ ...complete, delivery: "delivery" }), ["address"]);
});

// ── Validation ─────────────────────────────────────────────────────────────────────────
test("prices come from the menu and unknown products are rejected", () => {
  const { items, rejected } = reconcileItems(
    [{ name: "classic  burger", quantity: 2, price: 1 }, { name: "Pizza", quantity: 1 }, { name: "Soda", quantity: 500 }],
    MENU,
  );
  assert.deepEqual(items, [{ name: "Classic Burger", quantity: 2, price: 9000 }]);
  assert.equal(rejected.length, 2);
});

test("tool executor: bad JSON, bad enums, unknown tools and disallowed tools return error strings", async () => {
  const session = { order: null, history: [] };
  const run = makeToolExecutor({ session, menu: MENU, info: "info", allowed: ["save_order_draft", "confirm_order"] });
  assert.match(await run("save_order_draft", "{not json"), /not valid JSON/);
  assert.match(await run("save_order_draft", JSON.stringify({ payment_method: "bitcoin" })), /payment_method must be one of/);
  assert.match(await run("get_menu", "{}"), /not available at this stage/);
  assert.match(await run("confirm_order", "{}"), /no open order/);
});

test("confirm_order is refused by code while data is missing", async () => {
  const session = { order: null, history: [] };
  const run = makeToolExecutor({ session, menu: MENU, info: "info", allowed: ["save_order_draft", "confirm_order"] });
  await run("save_order_draft", JSON.stringify({ items: [{ name: "Fries", quantity: 1 }] }));
  assert.match(await run("confirm_order", "{}"), /still missing customer_name/);
  assert.equal(session.order.status, "collecting");

  // Once complete, the tool result itself tells the model the order is NOT confirmed yet.
  const done = JSON.parse(
    await run("save_order_draft", JSON.stringify({ customer_name: "Ana", delivery_type: "pickup", payment_method: "cash" })),
  );
  assert.deepEqual(done.order.still_missing, []);
  assert.match(done.order.next_step, /NOT confirmed/);
});

// ── The loop ───────────────────────────────────────────────────────────────────────────
test("loop: forces the first tool, survives a tool error, falls back to tool_choice none after MAX_ROUNDS", async () => {
  const model = fakeModel([
    call(toolCall("a", "boom")),
    call(toolCall("b", "boom")),
    call(toolCall("c", "boom")),
    call(toolCall("d", "boom")),
    say("Here is what I have."),
  ]);
  const tools = [{ type: "function", function: { name: "boom" } }];
  const r = await converseWithTools({
    callModel: model,
    messages: [{ role: "user", content: "hi" }],
    tools,
    execute: async () => { throw new Error("db down"); },
    forceFirst: "boom",
  });
  assert.equal(r.text, "Here is what I have.");
  assert.equal(model.calls[0].opts.forceTool, "boom");
  assert.equal(model.calls[1].opts.forceTool, undefined);
  assert.equal(model.calls[4].opts.noTools, true);
  assert.match(model.calls[1].messages.at(-1).content, /Tool error: db down/);
});

// ── A full conversation with a scripted model ──────────────────────────────────────────
test("full order flow: routing changes stage by stage and the total is computed by code", async () => {
  const store = createSessionStore();
  const turn = (text, script) => handleMessage({ store, sessionId: "s", text, callModel: fakeModel(script) });

  const t1 = await turn("hi, 2 classic burgers please", [
    call(toolCall("1", "get_menu")),
    call(toolCall("2", "save_order_draft", { items: [{ name: "Classic Burger", quantity: 2 }] })),
    say("Got it! What's your name?"),
  ]);
  assert.equal(t1.agent, "orchestrator");
  assert.equal(orderTotal(store.get("s").order.items), 18000);

  const t2 = await turn("Ana, pickup, cash", [
    call(toolCall("3", "get_menu")),
    call(toolCall("4", "save_order_draft", { customer_name: "Ana", delivery_type: "pickup", payment_method: "cash" })),
    say("Summary: 2 Classic Burger, total 18000. Confirm?"),
  ]);
  assert.equal(t2.agent, "collector");
  assert.equal(pickAgent(store.get("s").order).agent, "finalizer");

  const model3 = fakeModel([call(toolCall("5", "confirm_order")), say("Confirmed!")]);
  const t3 = await handleMessage({ store, sessionId: "s", text: "yes", callModel: model3 });
  assert.equal(t3.agent, "finalizer");
  assert.deepEqual(model3.calls[0].toolNames, ["save_order_draft", "confirm_order"]); // no menu tool at this stage
  assert.equal(store.get("s").order.status, "confirmed");

  // The next message starts a fresh order.
  assert.equal(pickAgent(store.get("s").order).agent, "orchestrator");
});

// ── The real OpenAI SDK against a local fake server ────────────────────────────────────
test("OpenAI SDK caller sends tools and tool_choice and parses tool calls", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push(JSON.parse(body));
      const n = seen.length;
      const message = n === 1
        ? { role: "assistant", content: null, tool_calls: [toolCall("x", "get_menu")] }
        : { role: "assistant", content: "We have burgers!" };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "c", object: "chat.completion", created: 0, model: "fake", choices: [{ index: 0, message, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const callModel = createOpenAICaller({ apiKey: "test-not-a-real-key", model: "fake", baseURL: `http://127.0.0.1:${server.address().port}/v1` });
    const store = createSessionStore();
    const r = await handleMessage({ store, sessionId: "s", text: "what do you sell?", callModel });
    assert.equal(r.reply, "We have burgers!");
    assert.deepEqual(r.toolsUsed, ["get_menu"]);
    assert.deepEqual(seen[0].tool_choice, { type: "function", function: { name: "get_menu" } }); // forced first round
    assert.equal(seen[1].tool_choice, "auto");
  } finally {
    server.close();
  }
});
