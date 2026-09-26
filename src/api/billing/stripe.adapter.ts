import { AppError } from "../../common/errors/AppError.js";
import type { BillingAdapter } from "./billing.adapter.js";

const API = "https://api.stripe.com/v1";
const TIMEOUT_MS = 10_000;
const failed = () =>
  new AppError("The payment processor request failed", 502, true, undefined, "PAYMENT_FAILED");

/**
 * Stripe over its REST API with fetch (no SDK dependency). Customers carry
 * only Aerwell ids as metadata: no member name, email or other PHI is sent.
 */
export function createStripeAdapter(secretKey: string, publishableKey: string): BillingAdapter {
  async function call<T>(
    method: "GET" | "POST",
    path: string,
    form?: Record<string, string>,
    idempotencyKey?: string
  ) {
    const headers: Record<string, string> = { authorization: `Bearer ${secretKey}` };
    if (form) headers["content-type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    let response: Response;
    try {
      response = await fetch(`${API}${path}`, {
        method,
        headers,
        ...(form ? { body: new URLSearchParams(form).toString() } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw failed();
    }
    // Processor messages may echo request details; never forward them.
    if (!response.ok) throw failed();
    return (await response.json()) as T;
  }
  return {
    configured: true,
    publishableKey,
    async createCustomer({ memberId, organizationId }) {
      const customer = await call<{ id: string }>(
        "POST",
        "/customers",
        { "metadata[memberId]": memberId, "metadata[organizationId]": organizationId },
        `aerwell-customer-${memberId}`
      );
      return customer.id;
    },
    async createSetupIntent(customerId) {
      const intent = await call<{ id: string; client_secret: string }>("POST", "/setup_intents", {
        customer: customerId,
        "payment_method_types[]": "card",
        usage: "off_session",
      });
      return { id: intent.id, clientSecret: intent.client_secret };
    },
    async retrievePaymentMethod(id) {
      const pm = await call<{
        id: string;
        customer: string | null;
        card?: { brand?: string; last4?: string; exp_month?: number; exp_year?: number };
      }>("GET", `/payment_methods/${encodeURIComponent(id)}`);
      return {
        id: pm.id,
        customerId: pm.customer,
        brand: pm.card?.brand ?? null,
        last4: pm.card?.last4 ?? null,
        expMonth: pm.card?.exp_month ?? null,
        expYear: pm.card?.exp_year ?? null,
      };
    },
  };
}
