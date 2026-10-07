import { type ClientSession, type Types } from "mongoose";
import { contractConflict } from "../alfred-partner/partner.errors.js";
import { SupplementOrder } from "../supplement/supplement.js";

/**
 * A clinician's prescription (a SupplementOrder draft) covers ONE purchase of up to its `qty`.
 * All three moves are single conditional writes inside the order's transaction, so two concurrent
 * orders cannot both hold one prescription: the loser conflicts, retries and finds it claimed.
 */
export async function claimPrescription(
  line: {
    organizationId: string;
    memberId: unknown;
    productId: unknown;
    quantity: number;
    orderId: Types.ObjectId;
  },
  session: ClientSession
) {
  const claimed = await SupplementOrder.findOneAndUpdate(
    {
      organizationId: line.organizationId,
      memberId: line.memberId,
      productId: line.productId,
      claimedByOrderId: null,
      qty: { $gte: line.quantity },
    },
    { $set: { claimedByOrderId: line.orderId } },
    // Tightest fit first, so a small purchase does not burn a large prescription.
    { session, sort: { qty: 1, createdAt: 1 }, timestamps: false }
  );
  if (!claimed)
    throw contractConflict(
      "MEMBERSHIP_REQUIRED",
      "This item needs an unused clinician's prescription covering that quantity"
    );
}

export const consumePrescriptions = (orderId: unknown, session: ClientSession) =>
  SupplementOrder.updateMany(
    { claimedByOrderId: orderId },
    { $set: { consumedAt: new Date() } },
    { session, timestamps: false }
  );

export const releasePrescriptions = (orderId: unknown, session: ClientSession) =>
  SupplementOrder.updateMany(
    { claimedByOrderId: orderId },
    { $set: { claimedByOrderId: null, consumedAt: null } },
    { session, timestamps: false }
  );
