import type { Request } from "express";
import { actor } from "../../common/http.js";
import { audit } from "../audit/audit.js";
import { Employment } from "../staff/staff-details.model.js";
import { StaffMember } from "../staff/staff.model.js";
import { staffTarget } from "../staff/staff.service.js";
import { Availability, OnboardingChecklist } from "./schedule.model.js";
import { ONBOARDING_STEPS } from "./schedule.schema.js";
import { staffFilter } from "./shift.service.js";

const unavailableWeek = () =>
  Array.from({ length: 7 }, (_, weekday) => ({ weekday, available: false }));
export async function readAvailability(req: Request) {
  const target = await staffTarget(req);
  const scope = { organizationId: target.organizationId, staffId: target._id };
  await audit(req, "viewed", "StaffAvailability", String(target._id));
  return (await Availability.findOne(scope).lean()) ?? { ...scope, days: unavailableWeek() };
}
export async function saveAvailability(req: Request) {
  const target = await staffTarget(req);
  const scope = { organizationId: target.organizationId, staffId: target._id };
  const row = await Availability.findOneAndUpdate(
    scope,
    { $set: { days: req.body.days } },
    { upsert: true, new: true, runValidators: true }
  ).lean();
  await audit(req, "updated", "StaffAvailability", String(target._id));
  return row;
}
const defaultSteps = () => ONBOARDING_STEPS.map((key) => ({ key, complete: false }));
/**
 * New hires to onboard: pending-onboarding staff, plus anyone whose saved checklist
 * still has an incomplete step. Deactivated staff are never listed.
 */
export async function onboarding(req: Request) {
  const visible = staffFilter(req);
  const organizationId = actor(req).organizationId;
  const checklists = await OnboardingChecklist.find({ organizationId }).lean();
  const byStaff = new Map(checklists.map((c) => [String(c.staffId), c.steps]));
  const incomplete = checklists
    .filter((c) => c.steps.some((s) => !s.complete))
    .map((c) => c.staffId);
  const people = await StaffMember.find({
    ...visible,
    accountStatus: { $ne: "deactivated" },
    $and: [{ $or: [{ accountStatus: "pending_onboarding" }, { _id: { $in: incomplete } }] }],
  })
    .select("firstName lastName roleId photoUrl accountStatus")
    .sort({ lastName: 1, _id: 1 })
    .lean();
  const employments = await Employment.find({
    organizationId,
    staffId: { $in: people.map((p) => p._id) },
  })
    .select("staffId startDate")
    .lean();
  const startDates = new Map(employments.map((e) => [String(e.staffId), e.startDate]));
  await audit(req, "viewed", "StaffOnboarding", organizationId);
  return people
    .map((staff) => ({
      staff,
      employment: { startDate: startDates.get(String(staff._id)) ?? null },
      steps: byStaff.get(String(staff._id)) ?? defaultSteps(),
    }))
    .filter((item) => item.steps.some((s) => !s.complete));
}
export async function updateOnboarding(req: Request) {
  const target = await staffTarget(req);
  const row = await OnboardingChecklist.findOneAndUpdate(
    { organizationId: target.organizationId, staffId: target._id },
    { $set: { steps: req.body.steps } },
    { upsert: true, new: true, runValidators: true }
  ).lean();
  await audit(req, "updated", "StaffOnboarding", String(target._id));
  return row;
}
export async function providers(req: Request) {
  await audit(req, "viewed", "StaffProviders", actor(req).organizationId);
  return StaffMember.find({ ...staffFilter(req), isProvider: true, accountStatus: "active" })
    .select("firstName lastName roleId photoUrl homeLocationId")
    .sort({ lastName: 1, _id: 1 })
    .lean();
}
