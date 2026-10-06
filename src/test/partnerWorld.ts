import { randomUUID } from "node:crypto";
import { DAY, at, bookingWorld } from "./appointmentFixture.js";
import { ACCOUNT, alfredClient } from "./partnerFixture.js";
import { app } from "./scheduleFixture.js";

export interface Slot {
  slotRef: string;
  startAt: string;
  endAt: string;
  locationRef: string;
  staffRef: string;
  staffName: string;
  capacityLeft: number;
}
export const NONE_PAID = { status: "none", amountCents: 17500, currency: "usd" } as const;
export const PAID = {
  status: "paid",
  paymentIntentId: "pi_test_123",
  amountCents: 17500,
  currency: "usd",
} as const;

/**
 * The booking world plus an Alfred-linked member (no plan: payment is Alfred's business, not Aerwell's)
 * and helpers that list slots through the partner API exactly as Alfred does, then book what was listed.
 */
export async function partnerWorld() {
  const w = await bookingWorld();
  const member = await w.member([], { alfredAccountId: ACCOUNT, status: "active" });
  const alfred = alfredClient(app);
  const window = (day: string) => ({
    from: at(day, "00:00").toISOString(),
    to: at(day, "23:59").toISOString(),
  });
  async function slots(slug: string, day = DAY, extra: Record<string, string> = {}) {
    const params = new URLSearchParams({
      itemRef: slug,
      accountId: ACCOUNT,
      ...window(day),
      ...extra,
    });
    const res = await alfred.get(`/availability?${params}`);
    if (res.status !== 200) throw new Error(`availability ${res.status}`);
    return res.body.data.slots as Slot[];
  }
  async function slotAt(slug: string, time: string, day = DAY, extra: Record<string, string> = {}) {
    const found = (await slots(slug, day, extra)).find(
      (s) => s.startAt === at(day, time).toISOString()
    );
    if (!found) throw new Error(`no ${slug} slot at ${time} on ${day}`);
    return found;
  }
  const bodyFor = (slug: string, slot: Slot, extra: Record<string, unknown> = {}) => ({
    accountId: ACCOUNT,
    itemRef: slug,
    slotRef: slot.slotRef,
    locationRef: slot.locationRef,
    payment: NONE_PAID,
    acceptedTermsVersion: "2026-10",
    ...extra,
  });
  async function book(
    slug: string,
    time: string,
    extra: Record<string, unknown> = {},
    key = randomUUID()
  ) {
    const slot = await slotAt(slug, time);
    return alfred.post("/bookings", bodyFor(slug, slot, extra), key);
  }
  return { ...w, aMember: member, alfred, slots, slotAt, bodyFor, book };
}
export type PartnerWorld = Awaited<ReturnType<typeof partnerWorld>>;
