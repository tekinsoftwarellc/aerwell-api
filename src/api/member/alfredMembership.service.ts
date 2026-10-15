import mongoose, { type Types } from "mongoose";
import { NotFoundError } from "../../common/errors/AppError.js";
import { MembershipPlan } from "../catalog/catalog.model.js";
import { Member, MemberMembership } from "./member.model.js";

export interface AlfredMembershipInput {
  tierKey: string;
  status: "active" | "suspended" | "cancelled";
  /** ISO timestamp; omitted means open-ended (contract §5.2) and clears a previous one. */
  validUntil?: string | undefined;
  /** Who made the grant in Alfred. "stripe" = the member pays by card there. */
  source?: "stripe" | "partner" | "admin" | undefined;
}

const LOCAL_STATUS = { active: "active", suspended: "paused", cancelled: "cancelled" } as const;

/**
 * Mirror a pushed membership into a local MemberMembership when `tierKey` is the slug of one of
 * this org's plans (`bundled` and unknown keys stay record-only). Rows written here are marked
 * `source: "alfred"` and never enqueue an outbound grant (echo rule). One live row per member:
 * a different plan ends the previous one. Replaying the same push changes nothing.
 */
async function mirrorPlan(
  member: { _id: unknown; organizationId: string },
  input: AlfredMembershipInput
) {
  const plan = await MembershipPlan.findOne({
    organizationId: member.organizationId,
    slug: input.tierKey,
    status: "active",
  }).lean();
  if (!plan) return;
  const status = LOCAL_STATUS[input.status];
  const endsAt = input.validUntil ? new Date(input.validUntil) : null;
  const now = new Date();
  await mongoose.connection.transaction(async (session) => {
    // Serialise writers for this member (concurrent pushes conflict and retry).
    await Member.updateOne({ _id: member._id }, { $inc: { membershipRevision: 1 } }, { session });
    const live = await MemberMembership.find({
      organizationId: member.organizationId,
      memberId: member._id,
      status: { $ne: "cancelled" },
    }).session(session);
    const mine = live.find((row) => String(row.planId) === String(plan._id));
    if (status === "cancelled") {
      if (mine) {
        mine.set({ status, cancelledAt: now });
        await mine.save({ session });
      }
      return;
    }
    for (const row of live) {
      if (row === mine) continue;
      row.set({ status: "cancelled", cancelledAt: now });
      await row.save({ session });
    }
    if (mine) {
      mine.set({ status, endsAt, source: "alfred" });
      await mine.save({ session });
      return;
    }
    await MemberMembership.create(
      [
        {
          organizationId: member.organizationId,
          memberId: member._id,
          planId: plan._id,
          status,
          startedAt: now,
          endsAt,
          source: "alfred",
          priceCents: plan.priceCents ?? null,
          billingTerm: plan.billingTerm ?? null,
        },
      ],
      { session }
    );
  });
}

/**
 * Store what Alfred reports (contract §5.2) on `Member.alfredMembership`, then mirror a known
 * Aerwell plan slug into a local MemberMembership. Replaying the same body is a no-op in effect.
 */
export async function recordAlfredMembership(
  memberId: Types.ObjectId | string,
  input: AlfredMembershipInput
) {
  const validUntil = input.validUntil ? new Date(input.validUntil) : undefined;
  const member = await Member.findOneAndUpdate(
    { _id: memberId },
    {
      $set: {
        alfredMembership: {
          tierKey: input.tierKey,
          status: input.status,
          ...(validUntil ? { validUntil } : {}),
          ...(input.source ? { source: input.source } : {}),
          updatedAt: new Date(),
        },
      },
    }
  )
    .select("organizationId")
    .lean();
  if (!member) throw new NotFoundError("Member not found");
  await mirrorPlan(member, input);
  return {
    tierKey: input.tierKey,
    status: input.status,
    ...(validUntil ? { validUntil: validUntil.toISOString() } : {}),
  };
}
