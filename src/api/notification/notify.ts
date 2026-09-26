// The one delivery path for in-app notifications. Producers call `notify` AFTER
// their own transaction commits, and it never throws: a notification failure
// is logged by kind and error name only (no PHI) and the originating request
// still succeeds.
import { logger } from "../../common/utils/logger.js";
import { Member } from "../member/member.model.js";
import { permits, resolvePermissions } from "../role/permission.js";
import type {
  EffectivePermissions,
  PermissionLevel,
  PermissionModule,
} from "../role/permission.types.js";
import { organizationTimeZone } from "../schedule/flags.js";
import { addDays, localInstant, todayIn } from "../schedule/time.js";
import { StaffMember } from "../staff/staff.model.js";
import {
  Notification,
  type NotificationKind,
  type NotificationType,
} from "./notification.model.js";
import {
  NotificationPreference,
  NotificationRule,
  PREFERENCE_DEFAULTS,
  QUIET_HOURS_DEFAULT,
} from "./preference.model.js";

type Grant = { module: PermissionModule; level: PermissionLevel };
export type RuleTrigger =
  | "critical_lab_result"
  | "time_off_request"
  | "result_past_turnaround"
  | "failed_payment";
export interface Notice {
  organizationId: string;
  kind: NotificationKind;
  category: NotificationType;
  /** No member names or clinical values: the reader may lack access to them later. */
  title: string;
  link?: string;
  /** Never notified about their own action. */
  actorId?: unknown;
  /** Direct recipients (provider, requester, assigned clinicians). */
  staffIds?: unknown[];
  /** Also every active staff member holding this grant with scope "all". */
  audience?: Grant;
  /** Used as the audience only when nobody else can receive the notice. */
  fallback?: Grant;
  /** Also the roles of enabled NotificationRules for this trigger (in-app rules only). */
  rule?: RuleTrigger;
  /** Every recipient must hold all of these. */
  requires: Grant[];
  /** Own-scope recipients must be assigned to this member... */
  memberId?: unknown;
  /** ...or be this staff member (staff-record events). */
  subjectStaffId?: unknown;
  dedupeKey?: string;
}
const TITLE_MAX = 200;
type Recipient = { _id: unknown; permissions: EffectivePermissions };

async function candidateIds(n: Notice): Promise<Set<string>> {
  const ids = new Set((n.staffIds ?? []).map(String));
  if (n.rule) {
    const rules = await NotificationRule.find({
      organizationId: n.organizationId,
      trigger: n.rule,
      enabled: true,
      channels: "in_app",
    }).lean();
    const roleIds = rules.flatMap((r) => (r.recipient ? [r.recipient.id] : []));
    if (roleIds.length)
      for (const id of await StaffMember.distinct("_id", {
        organizationId: n.organizationId,
        roleId: { $in: roleIds },
      }))
        ids.add(String(id));
  }
  return ids;
}

/** Active staff in the org: the candidates, plus (for an audience) everyone. */
async function recipients(n: Notice): Promise<Recipient[]> {
  const ids = await candidateIds(n);
  if (!(ids.size || n.audience)) return [];
  const staff = await StaffMember.find({
    organizationId: n.organizationId,
    accountStatus: "active",
    deletedAt: null,
    ...(n.audience ? {} : { _id: { $in: [...ids] } }),
  })
    .select("organizationId roleId permissionOverrides isSuperAdmin")
    .lean();
  const assigned = n.memberId
    ? new Set(
        (
          await Member.findOne({ _id: n.memberId, organizationId: n.organizationId })
            .select("assignedClinicianIds")
            .lean()
        )?.assignedClinicianIds.map(String) ?? []
      )
    : new Set<string>();
  const out: Recipient[] = [];
  // ponytail: permissions resolved per staff member (one Role read each); fine at clinic size.
  for (const s of staff) {
    const id = String(s._id);
    if (id === String(n.actorId)) continue;
    const permissions = await resolvePermissions(s);
    const holds = (g: Grant) => permits(permissions[g.module].level, g.level);
    const inAudience =
      n.audience && holds(n.audience) && permissions[n.audience.module].scope === "all";
    if (!(ids.has(id) || inAudience) || !n.requires.every(holds)) continue;
    const modules = [
      ...n.requires.map((g) => g.module),
      ...(n.memberId ? ["MEMBER_RECORDS" as const] : []),
    ];
    const own = modules.some((m) => permissions[m].scope === "own");
    if (own && n.memberId && !assigned.has(id)) continue;
    if (own && n.subjectStaffId && id !== String(n.subjectStaffId)) continue;
    out.push({ _id: s._id, permissions });
  }
  return out;
}

const hhmm = (timeZone: string, now: Date) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
function safeInstant(date: string, time: string, tz: string) {
  try {
    return localInstant(date, time, tz);
  } catch {
    // A quiet-hours end inside a clock change (gap or repeat): an hour later.
    const hour = String(Number(time.slice(0, 2)) + 1).padStart(2, "0");
    return localInstant(date, `${hour}${time.slice(2)}`, tz);
  }
}
/** End of the quiet window containing `now`, or null when not quiet. */
export function quietUntil(
  quiet: { enabled: boolean; start: string; end: string },
  tz: string,
  now: Date
): Date | null {
  if (!quiet.enabled || quiet.start === quiet.end) return null;
  const local = hhmm(tz, now);
  const wraps = quiet.start > quiet.end;
  const inside = wraps
    ? local >= quiet.start || local < quiet.end
    : local >= quiet.start && local < quiet.end;
  if (!inside) return null;
  const today = todayIn(tz, now);
  return safeInstant(local < quiet.end ? today : addDays(today, 1), quiet.end, tz);
}

async function rows(n: Notice, people: Recipient[]) {
  const critical = n.category === "critical_alerts";
  const prefs = new Map(
    (
      await NotificationPreference.find({
        organizationId: n.organizationId,
        staffId: { $in: people.map((p) => p._id) },
      }).lean()
    ).map((p) => [String(p.staffId), p])
  );
  const tz = await organizationTimeZone(n.organizationId);
  const now = new Date();
  return people.flatMap((person) => {
    const pref = prefs.get(String(person._id));
    const wants = critical
      ? { in_app: true, email: true, push: true }
      : { ...PREFERENCE_DEFAULTS[n.category], ...pref?.matrix?.[n.category] };
    if (!wants.in_app) return [];
    const until = critical ? null : quietUntil(pref?.quietHours ?? QUIET_HOURS_DEFAULT, tz, now);
    return [
      {
        organizationId: n.organizationId,
        recipientStaffId: person._id,
        kind: n.kind,
        category: n.category,
        title: n.title.length > TITLE_MAX ? `${n.title.slice(0, TITLE_MAX - 1)}…` : n.title,
        link: n.link ?? null,
        critical,
        deliverAfter: until ?? now,
        deliveries: {
          in_app: until ? "deferred" : "delivered",
          email: wants.email ? "unconfigured" : "off",
          push: wants.push ? "unconfigured" : "off",
        },
        dedupeKey: n.dedupeKey,
      },
    ];
  });
}

/** Deliver one event to its recipients. Returns rows written; never throws. */
export async function notify(n: Notice): Promise<number> {
  try {
    let people = await recipients(n);
    if (!people.length && n.fallback)
      people = await recipients({ ...n, staffIds: [], rule: undefined, audience: n.fallback });
    const docs = await rows(n, people);
    if (!docs.length) return 0;
    try {
      return (await Notification.insertMany(docs, { ordered: false })).length;
    } catch (error) {
      // Duplicate dedupe keys: the rest of the batch is still written.
      const bulk = error as { code?: number; insertedDocs?: unknown[] };
      if (bulk.code === 11000) return bulk.insertedDocs?.length ?? 0;
      throw error;
    }
  } catch (error) {
    logger.warn({ kind: n.kind, error: (error as Error).name }, "Notification delivery failed");
    return 0;
  }
}
