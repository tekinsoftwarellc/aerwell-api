import type { Types } from "mongoose";
import { NotFoundError } from "../../common/errors/AppError.js";
import { Member } from "./member.model.js";

export interface AlfredMembershipInput {
  tierKey: string;
  status: "active" | "suspended" | "cancelled";
  /** ISO timestamp; omitted means open-ended (contract §5.2) and clears a previous one. */
  validUntil?: string | undefined;
}

/**
 * Store what Alfred reports (contract §5.2). RECORD ONLY: this writes `Member.alfredMembership`
 * and nothing else. It never creates a MemberMembership, ledger row, plan or entitlement; Aerwell
 * plans stay staff-only (Q4, no reverse flow). Replaying the same body is a no-op in effect.
 */
export async function recordAlfredMembership(
  memberId: Types.ObjectId | string,
  input: AlfredMembershipInput
) {
  const validUntil = input.validUntil ? new Date(input.validUntil) : undefined;
  const result = await Member.updateOne(
    { _id: memberId },
    {
      $set: {
        alfredMembership: {
          tierKey: input.tierKey,
          status: input.status,
          ...(validUntil ? { validUntil } : {}),
          updatedAt: new Date(),
        },
      },
    }
  );
  if (result.matchedCount === 0) throw new NotFoundError("Member not found");
  return {
    tierKey: input.tierKey,
    status: input.status,
    ...(validUntil ? { validUntil: validUntil.toISOString() } : {}),
  };
}
