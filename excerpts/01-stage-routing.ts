// EXCERPT 01 — Deterministic routing: which agent handles the next message.
//
// What this shows: the core design rule of the system. The CODE decides the agent from persisted
// order state; the model never decides who answers. Pure functions, no I/O, unit-testable.
// Source: the stage and router modules of the production turn handler (trimmed, identifiers
// translated from Spanish to English).
// Omitted: the system prompts of each agent, the catalog-order branch, and the full completeness
// rules (the real function also tracks phone and per-field state). Agent names are generalized.

export type Delivery = "delivery" | "pickup";
export type Payment = "cash" | "transfer";

export type SavedOrder = {
  status: "collecting" | "confirmed" | "delivered" | "cancelled";
  customerName: string | null;
  delivery: Delivery | null;
  address: string | null;
  payment: Payment | null;
  /** null = the owner has not set it yet (0 is a valid price: free delivery) */
  deliveryFee: number | null;
  paymentProofAt: string | null;
  items: { name: string; quantity: number; unitPrice: number }[];
};

export type OrderAgent =
  | "orchestrator"          // no open order: starts one
  | "collector"             // draft with missing fields: asks for what is missing
  | "final_pickup_cash"
  | "final_pickup_transfer_no_proof"
  | "final_pickup_transfer_with_proof"
  | "final_delivery_cash_no_fee"
  | "final_delivery_cash_with_fee"
  | "final_delivery_transfer_no_fee"
  | "final_delivery_transfer_no_proof"
  | "final_delivery_transfer_with_proof";

const isBlank = (v: string | null | undefined) => v == null || v.trim() === "" || v === "null";

/** What is still missing, in the order the collector asks for it. Address only counts for delivery. */
export function missingFields(o: SavedOrder): string[] {
  const missing: string[] = [];
  if (o.items.length === 0) missing.push("items");
  if (isBlank(o.customerName)) missing.push("name");
  if (isBlank(o.delivery)) missing.push("delivery_type");
  if (o.delivery === "delivery" && isBlank(o.address)) missing.push("address");
  if (isBlank(o.payment)) missing.push("payment_method");
  return missing;
}

export function pickOrderAgent(
  order: SavedOrder | null,
  opts: { customerConfirms?: boolean } = {},
): { agent: OrderAgent; reason: string } {
  if (!order || order.status === "delivered" || order.status === "cancelled") {
    return { agent: "orchestrator", reason: "no_open_order" };
  }
  const missing = missingFields(order);
  if (order.status === "collecting" && missing.length > 0) {
    return { agent: "collector", reason: "missing: " + missing.join(", ") };
  }
  // Complete draft but the customer did not say "yes" (a change, a question…): the collector can
  // fix the order and summarize again; the final agents only know how to confirm or escalate.
  if (order.status === "collecting" && opts.customerConfirms === false) {
    return { agent: "collector", reason: "complete_not_confirmed" };
  }

  const delivery = order.delivery === "delivery";
  const transfer = order.payment === "transfer";
  const confirmed = order.status === "confirmed";
  // Fee and proof of payment only exist AFTER confirmation, so they only matter once confirmed.
  const hasFee = confirmed && order.deliveryFee !== null;
  const hasProof = confirmed && !!order.paymentProofAt;

  if (!delivery) {
    if (!transfer) return { agent: "final_pickup_cash", reason: "complete" };
    return { agent: hasProof ? "final_pickup_transfer_with_proof" : "final_pickup_transfer_no_proof", reason: "complete" };
  }
  if (!transfer) return { agent: hasFee ? "final_delivery_cash_with_fee" : "final_delivery_cash_no_fee", reason: "complete" };
  if (!hasFee) return { agent: "final_delivery_transfer_no_fee", reason: "complete" };
  return { agent: hasProof ? "final_delivery_transfer_with_proof" : "final_delivery_transfer_no_proof", reason: "complete" };
}

// ── Top-level router ────────────────────────────────────────────────────────────────
export type Agent = "intent" | "closed_hours" | OrderAgent;

export function pickAgent(c: {
  businessStatus: "open" | "before_opening" | "already_closed";
  /** the intent the model declared earlier, if still valid (1 h TTL stored in the DB) */
  activeIntent?: string | null;
  order?: SavedOrder | null;
  customerConfirms?: boolean;
}): { agent: Agent; reason: string } {
  // While an order is in progress the order stage decides, even if the restaurant closed in the
  // meantime. The closing time only prevents STARTING a new order.
  if (c.activeIntent === "order") {
    const stage = pickOrderAgent(c.order ?? null, { customerConfirms: c.customerConfirms });
    if (stage.agent === "orchestrator" && c.businessStatus !== "open") {
      return { agent: "closed_hours", reason: c.businessStatus };
    }
    return { agent: stage.agent, reason: "order: " + stage.reason };
  }
  if (c.businessStatus !== "open") return { agent: "closed_hours", reason: c.businessStatus };
  return { agent: "intent", reason: "open" };
}
