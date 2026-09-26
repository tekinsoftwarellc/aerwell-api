import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DAY, pinClock } from "../../test/appointmentFixture.js";
import { as } from "../../test/scheduleFixture.js";
import { visitWorld } from "../../test/visitFixture.js";
import { Notification } from "../notification/notification.model.js";

// W7 x W9 integration: a visit run through the real routes (W6 status route,
// W9 consent/summary) shows up on the provider's W7 dashboard, and only the
// transitions W7 defines an event for produce notifications.
beforeEach(() => pinClock());
afterEach(() => vi.useRealTimers());

it("reflects in-progress and completed visits on the dashboard and notifies only defined events", async () => {
  const v = await visitWorld(false); // the director books for the provider
  const kinds = async () =>
    (await Notification.find({}).sort({ _id: 1 }).lean()).map((n) => n.kind);
  expect(await kinds()).toEqual(["appointment_booked"]);
  const dashboard = async () => {
    const provider = as(v.provider.accessToken);
    const [summary, agenda] = await Promise.all([
      provider.get(`/api/v1/dashboard/summary?date=${DAY}`),
      provider.get(`/api/v1/dashboard/agenda?date=${DAY}`),
    ]);
    expect([summary.status, agenda.status]).toEqual([200, 200]);
    const day = agenda.body.data.days.find((d: { date: string }) => d.date === DAY);
    return {
      kpi: summary.body.data.kpis.myAppointments,
      count: day.count,
      statuses: agenda.body.data.items.map((i: { status: string }) => i.status),
    };
  };

  expect((await v.status("checked_in")).status).toBe(200);
  expect((await v.status("in_progress")).status).toBe(200);
  expect((await v.consent()).status).toBe(201);
  const summary = await v.api.patch(`/api/v1/appointments/${v.id}/visit`, { summary: "Follow-up" });
  expect(summary.status).toBe(200);
  expect(await dashboard()).toEqual({ kpi: 1, count: 1, statuses: ["in_progress"] });

  expect((await v.api.post(`/api/v1/appointments/${v.id}/visit/consent/revoke`)).status).toBe(200);
  expect((await v.status("completed")).status).toBe(200);
  expect(await dashboard()).toEqual({ kpi: 1, count: 1, statuses: ["completed"] });

  // Check-in, start, consent, revoke and complete have no W7 notification kind.
  expect(await kinds()).toEqual(["appointment_booked"]);
});
