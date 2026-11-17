// ── TOOLS ─────────────────────────────────────────────────────────────────────────────
// Declared once; each agent only receives the tools its stage needs. The executor validates
// every argument and returns an error STRING to the model instead of throwing, so one bad call
// never kills the turn.
//
// Note: in the production system order mutations come back as parsed model output rather than
// tools (a legacy of the n8n prompts). Here they are tools to keep the demo small; the validation
// idea is the same: the model proposes, the code decides.

import { missingFields, newOrder, orderTotal } from "./order.js";
import { parseArgs, reconcileItems, validateDelivery, validatePayment } from "./validation.js";

const DEFINITIONS = {
  get_menu: {
    description: "Returns the current menu with the official prices. Always call it before quoting a price or adding products.",
    parameters: { type: "object", properties: {} },
  },
  get_business_info: {
    description: "General information: payment methods, delivery policy, opening hours.",
    parameters: { type: "object", properties: {} },
  },
  save_order_draft: {
    description:
      "Saves what the customer has told you so far. Send only the fields you learned in this message. " +
      "`items` replaces the whole item list, so send the complete list every time. Prices are added by the system.",
    parameters: {
      type: "object",
      properties: {
        customer_name: { type: "string" },
        delivery_type: { type: "string", enum: ["pickup", "delivery"] },
        address: { type: "string" },
        payment_method: { type: "string", enum: ["cash", "transfer"] },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, quantity: { type: "integer" } },
            required: ["name", "quantity"],
          },
        },
      },
    },
  },
  confirm_order: {
    description: "Confirms the order. Only call it after the customer explicitly said yes to the final summary.",
    parameters: { type: "object", properties: {} },
  },
};

/** Which tools each agent can use. The finalizer cannot browse the menu, only fix or confirm. */
export const TOOLS_BY_AGENT = {
  orchestrator: ["get_menu", "get_business_info", "save_order_draft"],
  collector: ["get_menu", "get_business_info", "save_order_draft"],
  finalizer: ["save_order_draft", "confirm_order"],
};

export function toolDefinitions(agent) {
  return TOOLS_BY_AGENT[agent].map((name) => ({ type: "function", function: { name, ...DEFINITIONS[name] } }));
}

function summary(order) {
  return {
    status: order.status,
    customer_name: order.customerName,
    delivery_type: order.delivery,
    address: order.address,
    payment_method: order.payment,
    items: order.items,
    total: orderTotal(order.items), // computed by code, never by the model
    still_missing: missingFields(order),
    // The stage is chosen BEFORE the turn, so the agent that fills the last field is not the
    // finalizer. The code tells the model what comes next instead of trusting the prompt alone.
    next_step:
      missingFields(order).length === 0
        ? "Order is complete but NOT confirmed. Show a short summary with this total and ask the customer for a clear yes. Do not say the order is placed."
        : "Ask for the next missing field.",
  };
}

/**
 * Builds the executor for one turn. `session` holds the in-memory order; `menu`/`info` are the
 * fictional business data. Returns async (name, rawArgs) => string.
 */
export function makeToolExecutor({ session, menu, info, allowed }) {
  return async (name, rawArgs) => {
    if (!allowed.includes(name)) return `Tool not available at this stage: ${name}`;
    const args = parseArgs(rawArgs);
    if (!args.ok) return `Error: ${args.error}`;

    switch (name) {
      case "get_menu":
        return JSON.stringify(menu.products.map(({ name, price }) => ({ name, price })));
      case "get_business_info":
        return info;
      case "save_order_draft": {
        const a = args.value;
        const delivery = validateDelivery(a.delivery_type);
        const payment = validatePayment(a.payment_method);
        if (!delivery.ok) return `Error: ${delivery.error}`;
        if (!payment.ok) return `Error: ${payment.error}`;

        let rejected = [];
        let items;
        if (a.items !== undefined) {
          ({ items, rejected } = reconcileItems(a.items, menu));
        }
        // Rejected products are NOT saved; the model is told, so it can ask the customer.
        // The order is created lazily: a greeting or a question does not open one.
        if (!session.order || session.order.status === "confirmed") session.order = newOrder();
        const order = session.order;
        if (items !== undefined && (items.length > 0 || rejected.length === 0)) order.items = items;
        if (typeof a.customer_name === "string" && a.customer_name.trim()) order.customerName = a.customer_name.trim();
        if (delivery.value) order.delivery = delivery.value;
        if (typeof a.address === "string" && a.address.trim()) order.address = a.address.trim();
        if (payment.value) order.payment = payment.value;
        if (order.delivery === "pickup") order.address = null; // an address makes no sense for pickup
        order.status = "collecting"; // any change reopens the draft: the final summary must be confirmed again
        return JSON.stringify({ saved: true, rejected, order: summary(order) });
      }
      case "confirm_order": {
        const order = session.order;
        if (!order) return "Cannot confirm: there is no open order";
        const missing = missingFields(order);
        if (missing.length > 0) return `Cannot confirm: still missing ${missing.join(", ")}`;
        order.status = "confirmed";
        return JSON.stringify({ confirmed: true, order: summary(order) });
      }
      default:
        return `Unknown tool: ${name}`;
    }
  };
}
