// ── VALIDATION: THE MODEL IS NOT TRUSTED WITH FACTS THAT CODE OWNS ────────────────────
// The model proposes product names and quantities. Prices, totals and which products exist come
// from the menu, never from the model.

const normalize = (s) =>
  String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Matches the proposed items against the real menu.
 * Returns the items that exist (with the MENU price) and the names that were not recognized.
 * Quantities must be integers between 1 and 20 (a typo like "100" should not become an order).
 */
export function reconcileItems(proposed, menu) {
  const byName = new Map(menu.products.map((p) => [normalize(p.name), p]));
  const items = [];
  const rejected = [];
  for (const it of Array.isArray(proposed) ? proposed : []) {
    const product = byName.get(normalize(it?.name ?? ""));
    const quantity = Number(it?.quantity);
    if (!product) {
      rejected.push(`"${it?.name}" is not on the menu`);
    } else if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
      rejected.push(`invalid quantity for "${product.name}": ${it?.quantity}`);
    } else {
      items.push({ name: product.name, quantity, price: product.price });
    }
  }
  return { items, rejected };
}

/** Tool arguments arrive as a JSON string written by the model: parse defensively. */
export function parseArgs(raw) {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? { ok: true, value: v } : { ok: false, error: "arguments must be a JSON object" };
  } catch {
    return { ok: false, error: "arguments are not valid JSON" };
  }
}

const DELIVERY = new Set(["pickup", "delivery"]);
const PAYMENT = new Set(["cash", "transfer"]);

/** Closed vocabularies: anything else is rejected and reported back to the model. */
export function validateEnum(value, allowed, label) {
  if (value == null) return { ok: true, value: undefined };
  return allowed.has(value) ? { ok: true, value } : { ok: false, error: `${label} must be one of: ${[...allowed].join(", ")}` };
}
export const validateDelivery = (v) => validateEnum(v, DELIVERY, "delivery_type");
export const validatePayment = (v) => validateEnum(v, PAYMENT, "payment_method");
