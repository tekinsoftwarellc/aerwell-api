import { randomUUID } from "node:crypto";
import { NotFoundError } from "../../common/errors/AppError.js";
import type { BillingAdapter, CardDetails } from "./billing.adapter.js";

/** In-memory processor for tests: no network, deterministic ids. */
export function createFakeBillingAdapter() {
  const customers = new Map<string, { memberId: string; organizationId: string }>();
  const cards = new Map<string, CardDetails>();
  const adapter: BillingAdapter & {
    customers: typeof customers;
    addCard(customerId: string, card: Omit<CardDetails, "customerId">): void;
  } = {
    configured: true,
    publishableKey: "pk_test_fake",
    customers,
    addCard(customerId, card) {
      cards.set(card.id, { ...card, customerId });
    },
    async createCustomer(ref) {
      const existing = [...customers].find(([, value]) => value.memberId === ref.memberId);
      if (existing) return existing[0];
      const id = `cus_fake_${customers.size + 1}`;
      customers.set(id, ref);
      return id;
    },
    async createSetupIntent(customerId) {
      const id = `seti_fake_${randomUUID()}`;
      return { id, clientSecret: `${id}_secret_${customerId}` };
    },
    async retrievePaymentMethod(id) {
      const card = cards.get(id);
      if (!card) throw new NotFoundError("Payment method not found");
      return card;
    },
  };
  return adapter;
}
