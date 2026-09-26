import { OrganizationSettings } from "../settings/settings.model.js";
import { Certification } from "../staff/staff-details.model.js";
import { StaffMember } from "../staff/staff.model.js";
import { PtoRequest, Shift } from "./schedule.model.js";
import { addDays, todayIn } from "./time.js";

export const CERT_RENEWAL_DAYS = 60;
export const DERIVED_FLAGS = ["pto_requested", "certification_renewal", "open_shift"] as const;
export type DerivedFlag = (typeof DERIVED_FLAGS)[number];
export type FlagSets = Map<DerivedFlag, Set<string>>;
const LABELS = new Map<DerivedFlag, string>([
  ["pto_requested", "PTO requested"],
  ["certification_renewal", "Certification up for renewal"],
  ["open_shift", "Open shift available"],
]);
export const isDerivedFlag = (value: string): value is DerivedFlag =>
  (DERIVED_FLAGS as readonly string[]).includes(value);

export async function organizationTimeZone(organizationId: string) {
  const settings = await OrganizationSettings.findOne({ organizationId }).select("timeZone").lean();
  return settings?.timeZone ?? "America/Los_Angeles";
}
export const organizationToday = async (organizationId: string) =>
  todayIn(await organizationTimeZone(organizationId));

const ids = (values: unknown[]) => new Set(values.map(String));
/** Staff ids per derived flag. Directory filters and row labels share this, so they cannot disagree. */
export async function derivedFlagSets(
  organizationId: string,
  kinds: readonly DerivedFlag[] = DERIVED_FLAGS
): Promise<FlagSets> {
  const today = await organizationToday(organizationId);
  const produce = async (kind: DerivedFlag): Promise<unknown[]> => {
    if (kind === "pto_requested")
      return PtoRequest.distinct("staffId", { organizationId, status: "pending" });
    if (kind === "certification_renewal")
      return Certification.distinct("staffId", {
        organizationId,
        expirationDate: { $lte: addDays(today, CERT_RENEWAL_DAYS) },
      });
    // An upcoming unassigned shift flags every active staff member who holds that position role.
    const roleIds = await Shift.distinct("positionRoleId", {
      organizationId,
      staffId: null,
      date: { $gte: today },
    });
    return StaffMember.distinct("_id", {
      organizationId,
      accountStatus: "active",
      deletedAt: null,
      roleId: { $in: roleIds },
    });
  };
  const entries = await Promise.all(
    kinds.map(async (kind) => [kind, ids(await produce(kind))] as const)
  );
  return new Map(entries);
}
export const flagsFor = (sets: FlagSets, staffId: string) =>
  [...sets]
    .filter(([, members]) => members.has(staffId))
    .map(([kind]) => ({ _id: `${kind}-${staffId}`, kind, label: LABELS.get(kind) ?? kind }));
/** Staff whose assigned shift contains `now` (instants, so DST-safe). */
export async function onDutyIds(organizationId: string, now = new Date()) {
  return ids(
    await Shift.distinct("staffId", {
      organizationId,
      staffId: { $ne: null },
      startAt: { $lte: now },
      endAt: { $gt: now },
    })
  );
}
