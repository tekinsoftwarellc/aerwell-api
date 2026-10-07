import { randomUUID } from "node:crypto";
import type { Types } from "mongoose";
import { SupplementOrder, SupplementProduct } from "../api/supplement/supplement.js";
import { ORG, memberRow } from "./memberFixture.js";
import { ACCOUNT, alfredClient, alfredToken } from "./partnerFixture.js";
import { app } from "./scheduleFixture.js";
import { staffFixture } from "./staffFixture.js";

/** A synthetic address with sentinel text: nothing may leak it into a log, an event or a response. */
export const ADDRESS = {
  line1: "ADDRESS-SENTINEL-1 Maple Street",
  line2: "Apt 4",
  city: "Las Vegas",
  region: "NV",
  postalCode: "89104",
  country: "US",
} as const;

let counter = 0;
/** An Alfred-linked member, a prescriber, and helpers that call the partner API exactly as Alfred does. */
export async function productWorld(existing?: { _id: Types.ObjectId }) {
  const member = existing ?? (await memberRow({ alfredAccountId: ACCOUNT, status: "active" }));
  const prescriber = await staffFixture(false, 0);
  const alfred = alfredClient(app);
  const org = alfredClient(app, alfredToken({ accountId: null }));
  async function product(over: Record<string, unknown> = {}) {
    counter += 1;
    return SupplementProduct.create({
      organizationId: ORG,
      sku: `demo-${counter}`,
      name: `Demo product ${counter}`,
      priceCents: 3400,
      stock: 10,
      forSale: true,
      ...over,
    });
  }
  /** The clinician's prescription: a SupplementOrder draft is what makes the product orderable. */
  const prescribe = (productId: unknown, memberId: unknown = member._id) =>
    SupplementOrder.create({
      organizationId: ORG,
      memberId,
      prescribedById: prescriber.staff._id,
      productId,
      product: { name: "Demo", priceCents: 3400 },
      directions: "Daily",
      durationDays: 30,
      qty: 1,
      fulfillment: "ship",
      pricing: { subtotalCents: 3400, totalCents: 3400 },
    });
  const body = (items: { itemRef: string; quantity: number }[], extra: object = {}) => ({
    accountId: ACCOUNT,
    items,
    shippingAddress: ADDRESS,
    payment: { status: "none", amountCents: 0, currency: "usd" },
    acceptedTermsVersion: "2026-10",
    ...extra,
  });
  const place = (
    items: { itemRef: string; quantity: number }[],
    extra: object = {},
    key = randomUUID() as string
  ) => alfred.post("/orders", body(items, extra), key as never);
  const event = (
    type: "order.paid" | "order.refunded",
    ref: string,
    payload: object = {},
    key = randomUUID() as string
  ) =>
    org.post("/events", {
      idempotencyKey: key,
      type,
      occurredAt: new Date().toISOString(),
      accountId: ACCOUNT,
      resource: { kind: "order", ref },
      payload: { kind: "purchase", ref, accountId: ACCOUNT, currency: "usd", ...payload },
    });
  return { member, prescriber, alfred, org, product, prescribe, place, event, body };
}
export type ProductWorld = Awaited<ReturnType<typeof productWorld>>;
