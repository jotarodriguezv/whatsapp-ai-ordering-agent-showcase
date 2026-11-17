// ── ORDER STATE AND ROUTING ──────────────────────────────────────────────────────────
// The order lives in the session store. The CODE decides which agent answers next, from this
// state. The model never picks the agent (same rule as the production system).

const isBlank = (v) => v == null || String(v).trim() === "";

export function newOrder() {
  return { status: "collecting", customerName: null, delivery: null, address: null, payment: null, items: [] };
}

/** What is still missing, in the order the collector asks for it. Address only counts for delivery. */
export function missingFields(o) {
  const missing = [];
  if (o.items.length === 0) missing.push("items");
  if (isBlank(o.customerName)) missing.push("customer_name");
  if (isBlank(o.delivery)) missing.push("delivery_type");
  if (o.delivery === "delivery" && isBlank(o.address)) missing.push("address");
  if (isBlank(o.payment)) missing.push("payment_method");
  return missing;
}

export const orderTotal = (items) => items.reduce((sum, i) => sum + i.quantity * i.price, 0);

/**
 * Stage → agent:
 *   no open order            → orchestrator (starts the order)
 *   draft with missing data  → collector    (asks for what is missing)
 *   complete draft           → finalizer    (summarizes, asks for a yes, confirms)
 */
export function pickAgent(order) {
  if (!order || order.status === "confirmed") return { agent: "orchestrator", reason: "no_open_order" };
  const missing = missingFields(order);
  if (missing.length > 0) return { agent: "collector", reason: `missing: ${missing.join(", ")}` };
  return { agent: "finalizer", reason: "complete" };
}
