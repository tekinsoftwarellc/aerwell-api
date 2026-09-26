import { AppError } from "../../common/errors/AppError.js";
import { env } from "../../config/env.js";
import { createStripeAdapter } from "./stripe.adapter.js";

export interface CardDetails {
  id: string;
  customerId: string | null;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}
/** Processor seam. Only the adapter talks to Stripe; the card number never reaches Aerwell. */
export interface BillingAdapter {
  readonly configured: boolean;
  readonly publishableKey: string | null;
  createCustomer(ref: { memberId: string; organizationId: string }): Promise<string>;
  createSetupIntent(customerId: string): Promise<{ id: string; clientSecret: string }>;
  retrievePaymentMethod(paymentMethodId: string): Promise<CardDetails>;
}

export const paymentsUnconfigured = () =>
  new AppError(
    "Payments are not configured. Card capture and billing are unavailable.",
    503,
    true,
    undefined,
    "PAYMENTS_UNCONFIGURED"
  );
const refuse = () => Promise.reject(paymentsUnconfigured());
const unconfigured: BillingAdapter = {
  configured: false,
  publishableKey: null,
  createCustomer: refuse,
  createSetupIntent: refuse,
  retrievePaymentMethod: refuse,
};

let override: BillingAdapter | null = null;
/** Tests swap in the in-memory fake; production never calls this. */
export function setBillingAdapter(adapter: BillingAdapter | null) {
  override = adapter;
}
export function getBillingAdapter(): BillingAdapter {
  if (override) return override;
  if (env.STRIPE_SECRET_KEY && env.STRIPE_PUBLISHABLE_KEY)
    return createStripeAdapter(env.STRIPE_SECRET_KEY, env.STRIPE_PUBLISHABLE_KEY);
  return unconfigured;
}
