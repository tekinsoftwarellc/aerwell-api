import type { Request } from "express";
import { Appointment, LIVE_STATUSES } from "../appointment/appointment.model.js";
import { dayStarts } from "../appointment/overview.service.js";
import { audit } from "../audit/audit.js";
import { Member } from "../member/member.model.js";
import { memberScope } from "../member/member.scope.js";
import { addDays } from "../schedule/time.js";
import { Service, ServiceCategory } from "../service/service.model.js";
import {
  type Ctx,
  clinicalNotes,
  context,
  labsScans,
  myAppointments,
  notConfigured,
  pendingTimeOff,
  staffToday,
  waitlists,
} from "./widgets.js";

// Figma tiles with no data model or agreed definition: explicit, never invented.
const INTERNAL_MEETINGS = notConfigured("No internal meeting model exists yet.");
const NEW_ASSESSMENTS = notConfigured(
  "What makes an assessment new or reviewed is not defined yet."
);
const MESSAGES = notConfigured("Messaging is not part of phase 1.");

function partOfDay(tz: string, now = new Date()) {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(
      now
    )
  );
  return hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
}
const auditDashboard = (ctx: Ctx, target: string) =>
  audit(ctx.req, "viewed", target, String(ctx.staff._id));

export async function summary(req: Request) {
  const ctx = await context(req);
  const [appointments, labs, notes, waits, staff] = await Promise.all([
    myAppointments(ctx),
    labsScans(ctx),
    clinicalNotes(ctx),
    waitlists(ctx),
    staffToday(ctx),
  ]);
  await auditDashboard(ctx, "Dashboard");
  return {
    date: ctx.date,
    timeZone: ctx.tz,
    greeting: { name: ctx.staff.firstName, partOfDay: partOfDay(ctx.tz) },
    kpis: {
      myAppointments: appointments,
      internalMeetings: INTERNAL_MEETINGS,
      newAssessments: NEW_ASSESSMENTS,
    },
    assessments: NEW_ASSESSMENTS,
    labsScans: labs,
    clinicalNotes: notes,
    waitlists: waits,
    staffToday: staff,
    messages: MESSAGES,
  };
}

/** Sunday-first week strip with my live appointment counts, and my day's agenda. */
export async function agenda(req: Request) {
  const ctx = await context(req);
  if (!ctx.can("APPOINTMENTS")) return null;
  const weekStart = addDays(ctx.date, -new Date(`${ctx.date}T12:00:00Z`).getUTCDay());
  const week = dayStarts(weekStart, ctx.tz);
  const rows = await Appointment.find({
    organizationId: ctx.org,
    providerId: ctx.staff._id,
    status: { $in: LIVE_STATUSES },
    startAt: { $gte: week(0), $lt: week(7) },
  })
    .sort({ startAt: 1, _id: 1 })
    .lean();
  const days = Array.from({ length: 7 }, (_, i) => ({
    date: addDays(weekStart, i),
    count: rows.filter((r) => r.startAt >= week(i) && r.startAt < week(i + 1)).length,
  }));
  const today = rows.filter((r) => r.startAt >= ctx.day(0) && r.startAt < ctx.day(1));
  const [services, categories, members] = await Promise.all([
    Service.find({ _id: { $in: today.map((r) => r.serviceId) } })
      .select("title")
      .lean(),
    ServiceCategory.find({ _id: { $in: today.map((r) => r.categoryId) } })
      .select("name color")
      .lean(),
    ctx.can("MEMBER_RECORDS")
      ? Member.find({ _id: { $in: today.map((r) => r.memberId) }, ...(await memberScope(req)) })
          .select("firstName lastName")
          .lean()
      : [],
  ]);
  const title = new Map(services.map((s) => [String(s._id), s.title]));
  const category = new Map(
    categories.map((c) => [String(c._id), { id: String(c._id), name: c.name, color: c.color }])
  );
  const name = new Map(members.map((m) => [String(m._id), `${m.firstName} ${m.lastName}`]));
  const items = today.map((r) => ({
    id: String(r._id),
    startAt: r.startAt,
    endAt: r.endAt,
    timeZone: r.timeZone,
    status: r.status,
    serviceTitle: title.get(String(r.serviceId)) ?? "Appointment",
    category: category.get(String(r.categoryId)) ?? null,
    memberName: name.get(String(r.memberId)) ?? null,
  }));
  const legend = [
    ...new Map(items.flatMap((i) => (i.category ? [[i.category.id, i.category]] : []))).values(),
  ];
  await auditDashboard(ctx, "DashboardAgenda");
  return { date: ctx.date, weekStart, days, items, legend };
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
/** Rule-based Daily Outlook (W10 swaps the message for Bedrock; actions stay data-derived). */
export async function outlook(req: Request) {
  const ctx = await context(req);
  const [labs, waits, timeOff] = await Promise.all([
    labsScans(ctx),
    waitlists(ctx),
    pendingTimeOff(ctx),
  ]);
  const actions = [];
  if (labs?.newCount)
    actions.push({
      kind: "review_reports",
      title: "Reports to Review",
      detail: [
        labs.counts.scans ? count(labs.counts.scans, "DEXA Scan") : "",
        labs.counts.labs ? count(labs.counts.labs, "Lab Result") : "",
      ]
        .filter(Boolean)
        .join(", "),
      cta: "Review",
      link: `/members/${labs.items[0]?.memberId}`,
    });
  for (const w of waits?.items ?? [])
    actions.push({
      kind: "schedule_waitlist",
      title: `${w.serviceName} Waitlist`,
      detail: count(w.memberCount, "Member"),
      cta: "Schedule",
      link: "/appointments",
    });
  if (timeOff)
    actions.push({
      kind: "approve_time_off",
      title: "Time Off Requests",
      detail: `${timeOff} to approve`,
      cta: "Review",
      link: "/staff",
    });
  await auditDashboard(ctx, "DashboardOutlook");
  return {
    message: !actions.length
      ? "Nothing needs you right now."
      : actions.length > 3
        ? "Busy day today! I've got some priorities you should tackle first."
        : "Here's what needs your attention today.",
    source: "rules",
    actions,
    total: actions.length,
  };
}
