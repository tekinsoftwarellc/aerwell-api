import type { Request } from "express";
import { actor } from "../../common/http.js";
import { Certification } from "../staff/staff-details.model.js";
import { StaffMember } from "../staff/staff.model.js";
import { CERT_RENEWAL_DAYS, organizationToday } from "./flags.js";
import { listPto } from "./pto.service.js";
import { listShifts, openShifts, staffFilter } from "./shift.service.js";
import { addDays } from "./time.js";
import { onboarding } from "./workforce.service.js";

const COVERAGE_LOOKAHEAD_DAYS = 7;
const DAY_MS = 86400000;
export type Priority = {
  id: string;
  kind: "coverage" | "certification" | "onboarding" | "pto";
  title: string;
  description: string;
  actionType: "assign_coverage" | "send_reminder" | "complete_onboarding" | "review_pto";
  staffId: string | null;
};
/** "14:00" → "2pm", "09:30" → "9:30am". */
export function shortTime(value: string) {
  const [hours = 0, minutes = 0] = value.split(":").map(Number);
  const suffix = hours < 12 ? "am" : "pm";
  const hour12 = hours % 12 || 12;
  return minutes ? `${hour12}:${String(minutes).padStart(2, "0")}${suffix}` : `${hour12}${suffix}`;
}
const shortDate = (date: string) =>
  new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
type Named = { firstName?: string; lastName?: string } | null | undefined;
const fullName = (staff: Named) => `${staff?.firstName ?? ""} ${staff?.lastName ?? ""}`.trim();

async function coveragePriorities(req: Request, date: string): Promise<Priority[]> {
  const gaps = await openShifts(req, date, addDays(date, COVERAGE_LOOKAHEAD_DAYS));
  return gaps.map((shift) => ({
    id: String(shift._id),
    kind: "coverage",
    title: `${shift.stationName ?? "Shift"} uncovered ${shortTime(shift.startTime)}–${shortTime(shift.endTime)} ${shortDate(shift.date)}`,
    description: "No staff assigned to this shift.",
    actionType: "assign_coverage",
    staffId: null,
  }));
}
async function certificationPriorities(req: Request, date: string): Promise<Priority[]> {
  const staff = await StaffMember.find({
    ...staffFilter(req),
    accountStatus: { $ne: "deactivated" },
  })
    .select("firstName lastName")
    .lean();
  const names = new Map(staff.map((s) => [String(s._id), fullName(s)]));
  const certs = await Certification.find({
    organizationId: actor(req).organizationId,
    staffId: { $in: staff.map((s) => s._id) },
    expirationDate: { $lte: addDays(date, CERT_RENEWAL_DAYS) },
  })
    .sort({ expirationDate: 1, _id: 1 })
    .lean();
  return certs.map((cert) => {
    const days = daysBetween(date, cert.expirationDate);
    const when = days >= 0 ? `expires in ${days} days` : `expired ${-days} days ago`;
    return {
      id: String(cert._id),
      kind: "certification",
      title: `${names.get(String(cert.staffId))}'s ${cert.name} ${when}`,
      description: `Renewal due ${shortDate(cert.expirationDate)}.`,
      actionType: "send_reminder",
      staffId: String(cert.staffId),
    };
  });
}
export async function overview(req: Request, requestedDate?: string) {
  const date = requestedDate ?? (await organizationToday(actor(req).organizationId));
  const [schedule, pendingPto, newHires, coverage, certifications] = await Promise.all([
    listShifts(req, { date, view: "day" }),
    listPto(req, "pending"),
    onboarding(req),
    coveragePriorities(req, date),
    certificationPriorities(req, date),
  ]);
  const onboardingRows: Priority[] = newHires.length
    ? [
        {
          id: "onboarding",
          kind: "onboarding",
          title: `${newHires.length} new ${newHires.length === 1 ? "hire needs" : "hires need"} onboarding`,
          description: `${newHires.map((h) => fullName(h.staff)).join(", ")}.`,
          actionType: "complete_onboarding",
          staffId: null,
        },
      ]
    : [];
  const ptoRows: Priority[] = pendingPto.map((p) => ({
    id: String(p._id),
    kind: "pto",
    title: `${fullName(p.staffId as Named)} requested ${p.days} ${p.days === 1 ? "day" : "days"} off`,
    description: `${shortDate(p.startDate)} – ${shortDate(p.endDate)}.`,
    actionType: "review_pto",
    staffId: String((p.staffId as { _id?: unknown } | null)?._id ?? ""),
  }));
  const priorities = [...coverage, ...certifications, ...onboardingRows, ...ptoRows];
  return {
    date,
    schedule,
    priorities,
    prioritiesTotal: priorities.length,
    pendingPto,
    onboarding: newHires,
  };
}
