// CLI: type a customer message, see the agent's reply plus what the system did behind it.
//   /state  prints the saved order     /reset  starts over     /exit  quits

import readline from "node:readline/promises";
import { createOpenAICaller, createSessionStore, handleMessage } from "./agent.js";
import { missingFields, orderTotal } from "./order.js";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("Missing OPENAI_API_KEY. Copy .env.example to .env and fill it in, or export the variable.");
  process.exit(1);
}

const callModel = createOpenAICaller({
  apiKey,
  model: process.env.OPENAI_MODEL || "gpt-4o-mini",
  baseURL: process.env.OPENAI_BASE_URL || undefined,
});
const store = createSessionStore();
const SESSION = "demo-customer";

function printState() {
  const o = store.get(SESSION).order;
  if (!o) return console.log("  (no order yet)");
  console.log(`  status=${o.status} total=${orderTotal(o.items)} missing=[${missingFields(o).join(", ")}]`);
  console.log("  " + JSON.stringify({ name: o.customerName, delivery: o.delivery, address: o.address, payment: o.payment, items: o.items }));
}

console.log("Demo Burger Corner (fictional). Say hi and place an order. /state, /reset, /exit\n");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "you > " });
rl.prompt();

// for-await keeps working when input is piped (a loop of rl.question() drops buffered lines)
for await (const raw of rl) {
  const line = raw.trim();
  if (line === "/exit") break;
  if (line === "/reset") { store.reset(SESSION); console.log("  session reset"); }
  else if (line === "/state") printState();
  else if (line) {
    try {
      const r = await handleMessage({ store, sessionId: SESSION, text: line, callModel });
      console.log(`bot > ${r.reply}`);
      console.log(`  [agent=${r.agent} (${r.reason}) tools=${r.toolsUsed.join(",") || "-"}]`);
    } catch (e) {
      console.log(`  [error: ${e.message}]`); // the session survives a failed turn
    }
  }
  rl.prompt();
}
rl.close();
