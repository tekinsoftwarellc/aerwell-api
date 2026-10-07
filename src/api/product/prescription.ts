import type { ClientSession, Types } from "mongoose";
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
  if (!claimed) throw contractConflict("MEMBERSHIP_REQUIRED", await refusalReason(line, session));
}

/** Why no prescription matched: none at all, only used ones, or none big enough. Text only, no codes. */
async function refusalReason(
  line: { organizationId: string; memberId: unknown; productId: unknown; quantity: number },
  session: ClientSession
): Promise<string> {
  const mine = {
    organizationId: line.organizationId,
    memberId: line.memberId,
    productId: line.productId,
  };
  if (!(await SupplementOrder.exists(mine).session(session)))
    return "This item needs a prescription from a clinician; none is on file for this member";
  if (await SupplementOrder.exists({ ...mine, claimedByOrderId: null }).session(session))
    return "The prescription on file covers a smaller quantity than ordered";
  return "The prescription on file has already been used";
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
