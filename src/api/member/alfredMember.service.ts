import { Types } from "mongoose";
import { contractConflict } from "../alfred-partner/partner.errors.js";
import { Location } from "../location/location.model.js";
import { Member } from "./member.model.js";

export interface AlfredProfile {
  accountId: string;
  firstName: string;
  lastName?: string;
  dateOfBirth?: string;
  gender?: string;
  baseLocationRef?: string;
}

/** Free-form Alfred gender text maps only where the stored value exists; anything else is left unset. */
const sexOf = (gender?: string): "male" | "female" | undefined => {
  const value = gender?.trim().toLowerCase();
  return value === "male" || value === "female" ? value : undefined;
};

async function homeLocationOf(organizationId: string, ref?: string) {
  if (!(ref && Types.ObjectId.isValid(ref))) return undefined;
  return (await Location.exists({ _id: ref, organizationId })) ? ref : undefined;
}

const isDuplicate = (error: unknown) => (error as { code?: number }).code === 11000;

/**
 * Find or create the clinical member record for an Alfred account (contract §5.1). The only
 * identifier is `alfredAccountId`: an existing local patient is never matched by name or email,
 * so two records can exist for one human until staff link them (Q3). A re-provision updates the
 * fields Alfred sent and never creates a second record. An archived record is a conflict.
 */
export async function provisionAlfredMember(organizationId: string, input: AlfredProfile) {
  const found = () => Member.findOne({ organizationId, alfredAccountId: input.accountId });
  const fields = {
    firstName: input.firstName,
    ...(input.lastName === undefined ? {} : { lastName: input.lastName }),
    ...(input.dateOfBirth ? { dateOfBirth: input.dateOfBirth } : {}),
    ...(sexOf(input.gender) ? { sex: sexOf(input.gender) } : {}),
  };
  const homeLocationId = await homeLocationOf(organizationId, input.baseLocationRef);
  const update = async (member: NonNullable<Awaited<ReturnType<typeof found>>>) => {
    if (member.archivedAt)
      throw contractConflict("MEMBER_CONFLICT", "This member record is archived");
    member.set({
      ...fields,
      ...(homeLocationId ? { homeLocationId } : {}),
      alfredUnlinkedAt: null,
    });
    await member.save();
    return { member, created: false };
  };
  const existing = await found();
  if (existing) return update(existing);
  try {
    const member = await Member.create({
      organizationId,
      alfredAccountId: input.accountId,
      status: "active",
      ...fields,
      ...(homeLocationId ? { homeLocationId } : {}),
    });
    return { member, created: true };
  } catch (error) {
    // A concurrent provision of the same account committed first.
    const winner = isDuplicate(error) ? await found() : null;
    if (winner) return update(winner);
    throw error;
  }
}
