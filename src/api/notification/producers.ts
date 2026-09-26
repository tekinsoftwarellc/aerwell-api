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
/** The member's assigned clinicians, or else everyone holding the fallback grant. */
async function memberAudience(memberId: Id, fallback: Notice["audience"]) {
  const member = await Member.findById(memberId).select("assignedClinicianIds").lean();
  const assigned = member?.assignedClinicianIds ?? [];
  return assigned.length ? { staffIds: assigned } : { audience: fallback };
}

interface PtoRow {
  organizationId: string;
  staffId: Id;
  startDate: string;
  endDate: string;
  status?: string | null;
}
export async function ptoRequested(row: PtoRow) {
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
export async function ptoDecided(row: PtoRow, actorId: Id) {
  await notify({
    organizationId: row.organizationId,
    kind: "pto_decided",
    category: "approvals",
    title: `Your time off ${range(row.startDate, row.endDate)} was ${row.status}`,
    link: `/staff/${row.staffId}`,
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
export async function appointmentChanged(
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

export async function clinicalReview(
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
export async function flagRaised(
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

export async function paymentFailed(processorInvoiceId: string) {
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

export async function inviteAccepted(staff: {
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

/** Daily: certifications expiring within 60 days (or expired), once per cert and date. */
export async function certificationNotices(organizationId: string) {
  const today = await organizationToday(organizationId);
  const certs = await Certification.find({
    organizationId,
    expirationDate: { $lte: addDays(today, CERT_RENEWAL_DAYS) },
  })
    .sort({ expirationDate: 1, _id: 1 })
    .lean();
  let written = 0;
  for (const cert of certs)
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
