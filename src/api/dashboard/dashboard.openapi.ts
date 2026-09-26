// Hand-maintained manifest for W7 dashboard and notification routes; the
// swagger drift test compares it with the mounted Express routes.
const error = { $ref: "#/components/schemas/ErrorResponse" };
const errors = {
  400: { description: "VALIDATION_ERROR", content: { "application/json": { schema: error } } },
  401: { description: "Staff session required" },
};
const dateParam = {
  name: "date",
  in: "query",
  required: false,
  schema: { type: "string", format: "date" },
  description: "Local date in the organization time zone (default today)",
};
type Spec = [method: string, path: string, tag: string, summary: string, parameters?: unknown[]];
const ops: Spec[] = [
  [
    "get",
    "/dashboard/summary",
    "Dashboard",
    "Home: greeting {name, partOfDay}, kpis {myAppointments (my live appointments in the local day; null without APPOINTMENTS view), internalMeetings and newAssessments ({status:'not_configured', reason})}, labsScans {newCount, counts, items<=3} (MEMBER_RECORDS + LABS_SCANS view), clinicalNotes {newCount, items<=3 by author} (MEMBER_RECORDS + CLINICAL_NOTES view), waitlists {memberCount, items by service} (MEMBER_RECORDS view), staffToday {count, items} (STAFF_RECORDS view). A widget is null when the reader lacks its permission; own scope limits every count. Audited.",
    [dateParam],
  ],
  [
    "get",
    "/dashboard/agenda",
    "Dashboard",
    "Mini calendar: Sunday-first weekStart, days[7] {date, count} of my live appointments, items for the date {startAt, endAt, status, serviceTitle, category {name, color}, memberName (null without MEMBER_RECORDS scope)}, legend. null without APPOINTMENTS view. Audited.",
    [dateParam],
  ],
  [
    "get",
    "/dashboard/outlook",
    "Dashboard",
    "Rule-based Daily Outlook {message, source:'rules', actions[] {kind, title, detail, cta, link}, total} from new labs/scans, waitlists and pending time off, each behind its permission. Audited.",
    [dateParam],
  ],
  [
    "get",
    "/notifications",
    "Notifications",
    "My delivered notifications, newest first {items[] {id, kind, category, title, link, critical, createdAt, deliveredAt, readAt}, unreadCount, nextCursor}. limit 1-50 (default 20), cursor, unread=true|false. Rows deferred by quiet hours appear when the window ends.",
    [
      {
        name: "limit",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 1, maximum: 50 },
      },
      {
        name: "cursor",
        in: "query",
        required: false,
        schema: { type: "string", pattern: "^[a-f0-9]{24}$" },
      },
      {
        name: "unread",
        in: "query",
        required: false,
        schema: { type: "string", enum: ["true", "false"] },
      },
    ],
  ],
  [
    "post",
    "/notifications/read-all",
    "Notifications",
    "Mark every delivered notification read {unreadCount}. Deferred rows stay unread.",
  ],
  [
    "post",
    "/notifications/{id}/read",
    "Notifications",
    "Mark one of my delivered notifications read (first read time kept) {unreadCount}. 404 for another staff member's row.",
    [
      {
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string", pattern: "^[a-f0-9]{24}$" },
      },
    ],
  ],
];
export const dashboardPaths: Record<string, Record<string, unknown>> = {};
for (const [method, path, tag, summary, parameters = []] of ops) {
  const key = `/api/v1${path}`;
  dashboardPaths[key] = {
    ...dashboardPaths[key],
    [method]: {
      summary,
      tags: [tag],
      security: [{ staffBearer: [] }],
      parameters,
      responses: { 200: { description: "Success envelope" }, ...errors },
    },
  };
}
