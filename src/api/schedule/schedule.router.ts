import { type Request, Router } from "express";
import { idParams, secured } from "../../common/http.js";
import { overview } from "./overview.service.js";
import { createPto, decidePto, listPto, ptoDetail, timeOff } from "./pto.service.js";
import {
  type ScheduleQuery,
  availabilityBody,
  dateQuery,
  decisionBody,
  monthQuery,
  onboardingBody,
  overviewQuery,
  ptoBody,
  ptoListQuery,
  scheduleQuery,
  shiftBody,
  shiftPatch,
  yearQuery,
} from "./schedule.schema.js";
import { createShift, deleteShift, listShifts, openShifts, updateShift } from "./shift.service.js";
import { addDays } from "./time.js";
import {
  onboarding,
  providers,
  readAvailability,
  saveAvailability,
  updateOnboarding,
} from "./workforce.service.js";

/** Mounted before the staff router so `/staff/overview` etc. never reach `/staff/:id`. */
export const schedulingRouter = Router();
const view = { module: "STAFF_RECORDS", level: "view" } as const;
const edit = { module: "STAFF_RECORDS", level: "edit" } as const;
const r = schedulingRouter;
const q = (req: Request) => req.query as Record<string, string | undefined>;
secured(r, "get", "/staff/shifts", view, { query: scheduleQuery }, (req) =>
  listShifts(req, req.query as unknown as ScheduleQuery)
);
secured(r, "post", "/staff/shifts", edit, { body: shiftBody }, createShift, 201);
const byId = { params: idParams };
secured(r, "patch", "/staff/shifts/:id", edit, { ...byId, body: shiftPatch }, updateShift);
secured(r, "delete", "/staff/shifts/:id", edit, byId, deleteShift);
secured(r, "get", "/staff/coverage", view, { query: dateQuery }, (req) => {
  const date = String(q(req)["date"]);
  return openShifts(req, date, addDays(date, 1));
});
secured(r, "get", "/staff/pto-requests", view, { query: ptoListQuery }, (req) =>
  listPto(req, q(req)["status"] as Parameters<typeof listPto>[1])
);
// Self-service: any signed-in staff member may request their own time off.
secured(r, "post", "/staff/pto-requests", null, { body: ptoBody }, createPto, 201);
secured(r, "get", "/staff/pto-requests/:id", view, byId, ptoDetail);
for (const decision of ["approve", "deny"] as const)
  secured(
    r,
    "post",
    `/staff/pto-requests/:id/${decision}`,
    edit,
    { ...byId, body: decisionBody },
    (req) => decidePto(req, decision === "approve")
  );
secured(r, "get", "/staff/onboarding", view, {}, onboarding);
secured(r, "get", "/staff/overview", view, { query: overviewQuery }, (req) =>
  overview(req, q(req)["date"])
);
secured(r, "get", "/staff/providers", view, {}, providers);
secured(r, "get", "/staff/:id/shifts", view, { ...byId, query: monthQuery }, (req) =>
  listShifts(req, {
    date: `${q(req)["month"]}-01`,
    view: "month",
    staffId: String(req.params["id"]),
  })
);
secured(r, "get", "/staff/:id/availability", view, byId, readAvailability);
secured(
  r,
  "put",
  "/staff/:id/availability",
  edit,
  { ...byId, body: availabilityBody },
  saveAvailability
);
secured(r, "get", "/staff/:id/time-off", view, { ...byId, query: yearQuery }, (req) =>
  timeOff(req, (req.query as { year?: number }).year)
);
secured(
  r,
  "patch",
  "/staff/:id/onboarding",
  edit,
  { ...byId, body: onboardingBody },
  updateOnboarding
);
