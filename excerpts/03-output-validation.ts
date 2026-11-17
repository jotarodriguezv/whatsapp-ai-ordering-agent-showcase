// EXCERPT 03 — Validating and reconciling the model's structured output.
//
// What this shows: the model is never trusted with facts that code or the database own.
//   · One parser (the original workflow had four divergent copies) turns tagged text into typed data
//     and collects `errors` instead of throwing.
//   · The customer's phone comes from the WhatsApp message, never from what the model wrote.
//   · Prices and totals are recomputed from the real menu (`reconcileWithMenu`): a model-invented
//     price would corrupt every total, so the menu price always wins and a warning is recorded.
//   · Unknown products are not saved.
// Source: the output-parser and order modules of the production turn handler (trimmed,
// identifiers translated). Omitted: the 7- and 9-field variants (confirmed/updated order), alert
// tags, and the free-text cleanup. The tag format is a legacy of the n8n prompts; moving to JSON
// structured output is planned once the prompts are refactored.

export type OrderItem = {
  name: string;
  quantity: number;
  price: number;
  customization: string | null;
  inMenu: boolean;
};
export type MenuProduct = { id: string; name: string; price: number };
export type Menu = { products: MenuProduct[] };

const normalize = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/** "null", empty or "undefined" (how a model writes an empty field) → null. */
export function fieldOrNull(v: string | null | undefined): string | null {
  const t = v?.trim() ?? "";
  return t === "" || /^(null|undefined|none|n\/a)$/i.test(t) ? null : t;
}

/** "1x ITEM A, 2x ITEM B (no ice)" → items. Splits on the comma followed by "2x ", so names with commas survive. */
export function parseProductsText(text: string) {
  const out: { quantity: number; name: string; customization: string | null }[] = [];
  for (const piece of text.split(/,\s*(?=\d+\s*x\s)/i)) {
    const m = piece.trim().match(/^(\d+)\s*x\s+(.+)$/i);
    if (!m) continue;
    let name = m[2].trim();
    let customization: string | null = null;
    const p = name.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
    if (p && p[1]) { name = p[1].trim(); customization = p[2].trim() || null; }
    const quantity = Number(m[1]);
    if (quantity > 0 && name) out.push({ quantity, name, customization });
  }
  return out;
}

/** The model does not always respect "no formatting": "83.000" and "83000,50" → 83000 and 83000.5. */
export function parseTotal(raw: string | null | undefined): number {
  const n = parseFloat(String(raw ?? "0").replace(/\./g, "").replace(/,/g, "."));
  return Number.isFinite(n) ? n : 0;
}

export type ParsedOrderOutput = {
  /** Text for the customer, tags stripped. */
  reply: string;
  draft: { name: string | null; phone: string; delivery: string | null; address: string | null; items: OrderItem[] } | null;
  errors: string[];
};

const FALLBACK_REPLY = "Perfect 👍";

export function parseOrderOutput(raw: string, opts: { customerPhone: string }): ParsedOrderOutput {
  const errors: string[] = [];
  let draft: ParsedOrderOutput["draft"] = null;

  // ORDER_DRAFT: name | phone | delivery | address | [items JSON]
  const m = raw.match(/^.*?ORDER_DRAFT:\s*(.+)$/m);
  if (m) {
    const parts = m[1].match(/^(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(\[[\s\S]*\])\s*$/);
    if (!parts) {
      errors.push("order_draft_malformed");
    } else {
      let items: OrderItem[] = [];
      try {
        const arr = JSON.parse(parts[5]) as { name: string; quantity: number; price: number }[];
        items = arr.map((i) => ({ name: i.name, quantity: Number(i.quantity), price: Number(i.price), customization: null, inMenu: false }));
      } catch {
        errors.push("order_draft_items_invalid_json");
      }
      draft = {
        name: fieldOrNull(parts[1]),
        // the phone on the order is the real customer's, not what the model typed
        phone: opts.customerPhone,
        delivery: fieldOrNull(parts[3]),
        address: fieldOrNull(parts[4]),
        items,
      };
    }
  }

  let reply = raw.replace(/ORDER_DRAFT:[^\n]*/g, "").replace(/ORDER_CONFIRMED:[^\n]*/g, "").trim();
  if (!reply) {
    errors.push("empty_reply");
    reply = FALLBACK_REPLY;
  }
  return { reply, draft, errors };
}

/**
 * Cross-checks what the model said against the real menu. If the product exists, ITS price is used
 * (never the model's). Products that are not recognized are marked and reported, and the caller drops them.
 */
export function reconcileWithMenu(items: OrderItem[], menu: Menu) {
  const warnings: string[] = [];
  const byName = new Map(menu.products.map((p) => [normalize(p.name), p]));
  const reconciled = items.map((it) => {
    const p = byName.get(normalize(it.name));
    if (!p) {
      warnings.push(`product_not_found: ${it.name}`);
      return { ...it, inMenu: false };
    }
    if (p.price !== it.price) warnings.push(`price_corrected: ${p.name} (model ${it.price}, menu ${p.price})`);
    return { ...it, name: p.name, price: p.price, inMenu: true };
  });
  return { items: reconciled, warnings };
}

export const orderTotal = (items: OrderItem[]) => items.reduce((s, i) => s + i.quantity * i.price, 0);
