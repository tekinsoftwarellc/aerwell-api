// Domain events -> notices. Each producer is called after its event's
// transaction has committed and inherits `notify`'s never-throw guarantee.
import { logger } from "../../common/utils/logger.js";
import { Invoice } from "../billing/billing.model.js";
import { Member } from "../member/member.model.js";
import type { PermissionLevel, PermissionModule } from "../role/permission.types.js";
import { CERT_RENEWAL_DAYS, organizationToday } from "../schedule/flags.js";
import { addDays } from "../schedule/time.js";
import { Service } from "../service/service.model.js";
import { Certification } from "../staff/staff-details.model.js";
import { StaffMember } from "../staff/staff.model.js";
import { type Notice, notify } from "./notify.js";

type Id = unknown;
const grant = (module: PermissionModule, level: PermissionLevel) => ({ module, level });
const RECORDS = grant("MEMBER_RECORDS", "view");
const STAFF_VIEW = grant("STAFF_RECORDS", "view");
const range = (start: string, end: string) => (start === end ? start : `${start} to ${end}`);
const when = (at: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
    .format(at)
    .replace(/\s/g, " ");
async function staffName(id: Id) {
  const s = await StaffMember.findById(id).select("firstName lastName").lean();
  return s ? `${s.firstName} ${s.lastName}` : "A staff member";
}
/** The member's assigned clinicians; `notify` falls back to the grant holders when none can receive it. */
async function memberAudience(memberId: Id, fallback: Notice["fallback"]) {
  const member = await Member.findById(memberId).select("assignedClinicianIds").lean();
  return { staffIds: member?.assignedClinicianIds ?? [], fallback };
}
/**
 * A producer's own lookups (names, titles, members) run before `notify`, so the
 * guard wraps the whole producer: nothing it does can reach the request.
 */
function safely<A extends unknown[]>(kind: string, produce: (...args: A) => Promise<void>) {
  return async (...args: A) => {
    try {
      await produce(...args);
    } catch (error) {
      logger.warn({ kind, error: (error as Error).name }, "Notification producer failed");
    }
  };
}

interface PtoRow {
  organizationId: string;
  staffId: Id;
  startDate: string;
  endDate: string;
  status?: string | null;
}
async function ptoRequestedNotice(row: PtoRow) {
  await notify({
    organizationId: row.organizationId,
    kind: "pto_requested",
    category: "approvals",
    title: `Time off requested: ${await staffName(row.staffId)} · ${range(row.startDate, row.endDate)}`,
    link: "/staff",
    actorId: row.staffId,
    audience: grant("STAFF_RECORDS", "edit"),
    rule: "time_off_request",
    requires: [STAFF_VIEW],
    subjectStaffId: row.staffId,
  });
}
async function ptoDecidedNotice(row: PtoRow, actorId: Id) {
  await notify({
    organizationId: row.organizationId,
    kind: "pto_decided",
    category: "approvals",
    title: `Your time off ${range(row.startDate, row.endDate)} was ${row.status}`,
    link: "/profile",
    actorId,
    staffIds: [row.staffId],
    requires: [],
  });
}

const VERBS = {
  appointment_booked: "New appointment",
  appointment_rescheduled: "Appointment moved",
  appointment_cancelled: "Appointment cancelled",
} as const;
interface AppointmentRow {
  organizationId: string;
  serviceId: Id;
  providerId: Id;
  startAt: Date;
  timeZone: string;
}
/** To the provider(s) only; the title names the service and time, never the member. */
async function appointmentChangedNotice(
  kind: keyof typeof VERBS,
  row: AppointmentRow,
  actorId: Id,
  providerIds: Id[] = [row.providerId]
) {
  const service = await Service.findById(row.serviceId).select("title").lean();
  await notify({
    organizationId: row.organizationId,
    kind,
    category: "appointments",
    title: `${VERBS[kind]}: ${service?.title ?? "Appointment"} · ${when(row.startAt, row.timeZone)}`,
    link: "/appointments",
    actorId,
    staffIds: providerIds,
    requires: [grant("APPOINTMENTS", "view")],
  });
}

async function clinicalReviewNotice(
  kind: "lab_review" | "scan_review",
  row: { organizationId: string; memberId: Id },
  actorId: Id
) {
  await notify({
    organizationId: row.organizationId,
    kind,
    category: "members",
    title: kind === "lab_review" ? "New lab results to review" : "New DEXA scan to review",
    link: `/members/${row.memberId}`,
    actorId,
    ...(await memberAudience(row.memberId, grant("LABS_SCANS", "edit"))),
    requires: [RECORDS, grant("LABS_SCANS", "view")],
    memberId: row.memberId,
  });
}

const label = (category: string) =>
  category.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
/** Title carries the flag category, never its free-text title (which may hold PHI). */
async function flagRaisedNotice(
  row: { organizationId: string; memberId: Id; category: string },
  actorId?: Id
) {
  await notify({
    organizationId: row.organizationId,
    kind: "flag_raised",
    category: "members",
    title: `Member flag raised: ${label(row.category)}`,
    link: `/members/${row.memberId}`,
    actorId,
    ...(await memberAudience(row.memberId, grant("MEMBER_RECORDS", "edit"))),
    requires: [RECORDS],
    memberId: row.memberId,
  });
}

/** Generic by design (Q8): no thread, member or message content in the title. */
async function memberMessageNotice(row: {
  organizationId: string;
  memberId: Id;
  dedupeKey: string;
}) {
  await notify({
    organizationId: row.organizationId,
    kind: "member_message",
    category: "members",
    title: "New member message",
    link: "/messages",
    ...(await memberAudience(row.memberId, grant("MEMBER_RECORDS", "edit"))),
    requires: [grant("MEMBER_RECORDS", "edit")],
    memberId: row.memberId,
    dedupeKey: row.dedupeKey,
  });
}

async function paymentFailedNotice(processorInvoiceId: string) {
  const invoice = await Invoice.findOne({ processorInvoiceId }).lean();
  if (!invoice) return;
  await notify({
    organizationId: invoice.organizationId,
    kind: "payment_failed",
    category: "billing",
    title: "A membership payment failed",
    link: `/members/${invoice.memberId}`,
    audience: grant("BILLING", "view"),
    rule: "failed_payment",
    requires: [RECORDS, grant("BILLING", "view")],
    memberId: invoice.memberId,
  });
}

async function inviteAcceptedNotice(staff: {
  _id: Id;
  organizationId: string;
  firstName: string;
  lastName: string;
}) {
  await notify({
    organizationId: staff.organizationId,
    kind: "invite_accepted",
    category: "system",
    title: `${staff.firstName} ${staff.lastName} accepted their invitation`,
    link: `/staff/${staff._id}`,
    actorId: staff._id,
    audience: grant("STAFF_RECORDS", "edit"),
    requires: [STAFF_VIEW],
    subjectStaffId: staff._id,
  });
}

export const ptoRequested = safely("ptoRequested", ptoRequestedNotice);
export const ptoDecided = safely("ptoDecided", ptoDecidedNotice);
export const appointmentChanged = safely("appointmentChanged", appointmentChangedNotice);
export const clinicalReview = safely("clinicalReview", clinicalReviewNotice);
export const flagRaised = safely("flagRaised", flagRaisedNotice);
export const memberMessage = safely("memberMessage", memberMessageNotice);
export const paymentFailed = safely("paymentFailed", paymentFailedNotice);
export const inviteAccepted = safely("inviteAccepted", inviteAcceptedNotice);

/** Daily: certifications expiring within 60 days (or expired), once per cert and date. */
export async function certificationNotices(organizationId: string) {
  const today = await organizationToday(organizationId);
  const certs = await Certification.find({
    organizationId,
    expirationDate: { $lte: addDays(today, CERT_RENEWAL_DAYS) },
  })
    .sort({ expirationDate: 1, _id: 1 })
    .lean();
  const active = new Set(
    (
      await StaffMember.distinct("_id", {
        _id: { $in: certs.map((c) => c.staffId) },
        accountStatus: "active",
        deletedAt: null,
      })
    ).map(String)
  );
  let written = 0;
  for (const cert of certs.filter((c) => active.has(String(c.staffId))))
    written += await notify({
      organizationId,
      kind: "certification_expiring",
      category: "system",
      title: `Certification expiring: ${await staffName(cert.staffId)} · ${cert.name} on ${cert.expirationDate}`,
      link: `/staff/${cert.staffId}`,
      audience: grant("STAFF_RECORDS", "master"),
      requires: [STAFF_VIEW],
      subjectStaffId: cert.staffId,
      dedupeKey: `cert:${cert._id}:${cert.expirationDate}`,
    });
  return written;
}
const JOB_INTERVAL_MS = 6 * 3600000;
/** In-process scheduler; dedupe keys make every rerun (and every restart) idempotent. */
export function startNotificationJobs(organizationId: string) {
  const run = () =>
    certificationNotices(organizationId).catch((error: Error) =>
      logger.warn({ error: error.name }, "Certification reminder job failed")
    );
  run(); // never rejects: the catch above logs and swallows
  return setInterval(run, JOB_INTERVAL_MS).unref();
}
