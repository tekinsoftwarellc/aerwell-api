import type { Request } from "express";
import mongoose, { type ClientSession, type Types } from "mongoose";
import {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../common/errors/AppError.js";
import { actor } from "../../common/http.js";
import { ledger } from "../appointment/ledger.service.js";
import { audit } from "../audit/audit.js";
import { MembershipPlan } from "../catalog/catalog.model.js";
import type { MembershipHolding } from "../entitlement/entitlement.types.js";
import { clinicianChatAllowed, usageKey } from "../entitlement/evaluate.js";
import { benefitPeriod } from "../entitlement/period.js";
import { loadCatalogSnapshot } from "../entitlement/snapshot.js";
import { Service } from "../service/service.model.js";
import { Member, type MemberDocument, MemberMembership } from "./member.model.js";
import { memberTarget } from "./member.scope.js";

export const USAGE_NOT_TRACKED = {
  tracked: false,
  reason: "Usage is recorded by the appointment allowance ledger (W6); used is 0 until then.",
} as const;
/** W6: used = units reserved or consumed in the allowance ledger for the current period. */
export const USAGE_TRACKED = {
  tracked: true,
  reason: "Units reserved by a booking or consumed by a visit, from the allowance ledger.",
} as const;
const BRAND_LABELS: Record<string, string> = {
  aerwell: "Aerwell Member",
  everhaus: "Everhaus Member",
};
type MembershipRow = {
  _id: unknown;
  planId: unknown;
  status: string;
  startedAt: Date;
  endsAt?: Date | null;
};
export const toHolding = (m: MembershipRow): MembershipHolding => ({
  id: String(m._id),
  planId: String(m.planId),
  status: m.status as MembershipHolding["status"],
  startedAt: m.startedAt,
  endsAt: m.endsAt ?? null,
});
const isCurrent = (m: MembershipRow, at: Date) =>
  m.status === "active" && m.startedAt <= at && (!m.endsAt || at < m.endsAt);

/** "Aerwell Member" / "Everhaus Member" from current memberships; Aerwell wins; null if none. */
export async function brandLabels(
  organizationId: string,
  memberIds: Types.ObjectId[],
  at = new Date()
) {
  const rows = await MemberMembership.find({
    organizationId,
    memberId: { $in: memberIds },
    status: "active",
  }).lean();
  const current = rows.filter((row) => isCurrent(row, at));
  const plans = await MembershipPlan.find({ _id: { $in: current.map((r) => r.planId) } })
    .select("brand")
    .lean();
  const brandOf = new Map(plans.map((p) => [String(p._id), p.brand]));
  const labels = new Map<string, string | null>();
  for (const row of current) {
    const label = BRAND_LABELS[brandOf.get(String(row.planId)) ?? ""];
    const key = String(row.memberId);
    if (label && labels.get(key) !== BRAND_LABELS["aerwell"]) labels.set(key, label);
  }
  return labels;
}

async function assignablePlan(organizationId: string, planId: string, session?: ClientSession) {
  const plan = await MembershipPlan.findOne({ _id: planId, organizationId }).session(
    session ?? null
  );
  if (!plan) throw new NotFoundError("Membership plan not found");
  // The baseline (Alfred Free) is implicit for everyone; legacy slug-less plans are read-only.
  if (plan.isBaseline || plan.status !== "active" || !plan.slug)
    throw new ValidationError("This plan cannot be assigned to a member", "PLAN_NOT_ASSIGNABLE");
  return plan;
}

/**
 * Serializes membership writers for one member (the member-doc bump makes
 * concurrent transactions conflict and retry), then refuses a same-plan overlap.
 */
async function lockAndAssertNoOverlap(
  member: MemberDocument,
  period: { planId: unknown; startedAt: Date; endsAt: Date | null; excludeId?: unknown },
  session: ClientSession
) {
  await Member.updateOne({ _id: member._id }, { $inc: { membershipRevision: 1 } }, { session });
  const overlap = await MemberMembership.exists({
    organizationId: member.organizationId,
    memberId: member._id,
    planId: period.planId,
    status: { $ne: "cancelled" },
    ...(period.excludeId ? { _id: { $ne: period.excludeId } } : {}),
    $and: [
      { $or: [{ endsAt: null }, { endsAt: { $gt: period.startedAt } }] },
      ...(period.endsAt ? [{ startedAt: { $lt: period.endsAt } }] : []),
    ],
  }).session(session);
  if (overlap)
    throw new ConflictError(
      "The member already holds this plan for that period",
      undefined,
      "MEMBERSHIP_OVERLAP"
    );
}

interface HoldInput {
  planId: string;
  startedAt?: Date;
  endsAt?: Date | null;
  autoRenew?: boolean;
}
/** Inside a transaction: the member-doc bump makes concurrent writers conflict and retry. */
export async function holdMembership(
  req: Request,
  member: MemberDocument,
  input: HoldInput,
  session: ClientSession
) {
  const plan = await assignablePlan(member.organizationId, input.planId, session);
  const startedAt = input.startedAt ?? new Date();
  const endsAt = input.endsAt ?? null;
  await lockAndAssertNoOverlap(member, { planId: plan._id, startedAt, endsAt }, session);
  const [row] = await MemberMembership.create(
    [
      {
        organizationId: member.organizationId,
        memberId: member._id,
        planId: plan._id,
        startedAt,
        endsAt,
        autoRenew: input.autoRenew ?? true,
        priceCents: plan.priceCents ?? null,
        billingTerm: plan.billingTerm ?? null,
        createdById: actor(req)._id,
      },
    ],
    { session }
  );
  if (!row) throw new AppError("Membership was not created");
  await audit(req, "created", "MemberMembership", String(row._id), String(member._id), session);
  return row;
}

export async function createMembership(req: Request) {
  const member = await memberTarget(req, { write: true });
  return mongoose.connection.transaction((session) =>
    holdMembership(req, member, req.body, session)
  );
}

export async function listMemberships(req: Request) {
  const member = await memberTarget(req);
  const rows = await MemberMembership.find({
    organizationId: member.organizationId,
    memberId: member._id,
  })
    .sort({ startedAt: -1, _id: -1 })
    .lean();
  const plans = await MembershipPlan.find({ _id: { $in: rows.map((r) => r.planId) } }).lean();
  const planOf = new Map(plans.map((p) => [String(p._id), p]));
  const snapshot = await loadCatalogSnapshot(member.organizationId);
  await audit(req, "viewed", "MemberMemberships", String(member._id), String(member._id));
  return {
    items: rows.map((row) => {
      const plan = planOf.get(String(row.planId));
      return {
        ...row,
        planName: plan?.name ?? null,
        brand: plan?.brand ?? null,
        clinicianChat: plan?.clinicianChat ?? false,
      };
    }),
    clinicianChatAllowed: clinicianChatAllowed(snapshot.plans, rows.map(toHolding), new Date()),
  };
}

const TRANSITIONS: Record<string, string[]> = {
  active: ["paused", "cancelled"],
  past_due: ["active", "cancelled"],
  paused: ["active", "cancelled"],
  cancelled: [],
};
const versionConflict = () =>
  new ConflictError("This membership changed; reload and try again", undefined, "VERSION_CONFLICT");
export async function patchMembership(req: Request) {
  const member = await memberTarget(req, { write: true });
  const { expectedVersion, ...changes } = req.body as {
    expectedVersion?: number;
    status?: string;
    endsAt?: Date | null;
    autoRenew?: boolean;
  };
  try {
    return await mongoose.connection.transaction(async (session) => {
      const row = await MemberMembership.findOne({
        _id: req.params["membershipId"],
        organizationId: member.organizationId,
        memberId: member._id,
      }).session(session);
      if (!row) throw new NotFoundError("Membership not found");
      if (
        expectedVersion !== undefined &&
        expectedVersion !== (row as unknown as { version: number }).version
      )
        throw versionConflict();
      if (
        changes.status &&
        changes.status !== row.status &&
        !TRANSITIONS[row.status]?.includes(changes.status)
      )
        throw new ValidationError(
          `A ${row.status} membership cannot become ${changes.status}`,
          "INVALID_MEMBERSHIP_TRANSITION"
        );
      if (changes.endsAt && changes.endsAt <= row.startedAt)
        throw new ValidationError("End must be after start", "INVALID_MEMBERSHIP_DATES");
      row.set(changes);
      if (changes.status === "cancelled" && !row.cancelledAt) row.cancelledAt = new Date();
      // A period change or a reactivation must not create a same-plan overlap.
      if (row.status !== "cancelled" && ("endsAt" in changes || "status" in changes))
        await lockAndAssertNoOverlap(
          member,
          {
            planId: row.planId,
            startedAt: row.startedAt,
            endsAt: row.endsAt ?? null,
            excludeId: row._id,
          },
          session
        );
      await row.save({ session });
      await audit(req, "updated", "MemberMembership", String(row._id), String(member._id), session);
      return row;
    });
  } catch (error) {
    if ((error as Error).name === "VersionError") throw versionConflict();
    throw error;
  }
}

/** Member Benefits view: used/remaining from the allowance ledger, renewal from the anniversary period. */
export async function memberBenefits(req: Request) {
  const member = await memberTarget(req);
  const at = (req.query["at"] as Date | undefined) ?? new Date();
  const rows = await MemberMembership.find({
    organizationId: member.organizationId,
    memberId: member._id,
  }).lean();
  const current = rows.filter((row) => isCurrent(row, at));
  const [snapshot, plans, services] = await Promise.all([
    loadCatalogSnapshot(member.organizationId),
    MembershipPlan.find({ _id: { $in: current.map((r) => r.planId) } }).lean(),
    Service.find({ organizationId: member.organizationId }).select("title slug").lean(),
  ]);
  const serviceOf = new Map(services.map((s) => [String(s._id), s]));
  const usage = await ledger.usage(
    member.organizationId,
    member._id,
    current.map(toHolding),
    snapshot.plans,
    at,
    {},
    null
  );
  const memberships = current.map((row) => {
    const plan = plans.find((p) => String(p._id) === String(row.planId));
    return {
      membershipId: String(row._id),
      planId: String(row.planId),
      planName: plan?.name ?? null,
      brand: plan?.brand ?? null,
      startedAt: row.startedAt,
      endsAt: row.endsAt ?? null,
      benefits: (plan?.benefits ?? []).map((benefit) => {
        const period =
          benefit.includedQuantity > 0 && benefit.period
            ? benefitPeriod(
                row.startedAt,
                { unit: benefit.period.unit, anchor: "anniversary", rollover: "none" },
                at
              )
            : null;
        const service = serviceOf.get(String(benefit.serviceId));
        const used = period ? (usage[usageKey(String(row._id), benefit.id)] ?? 0) : null;
        return {
          benefitId: benefit.id,
          serviceId: String(benefit.serviceId),
          serviceTitle: service?.title ?? null,
          serviceSlug: service?.slug ?? null,
          access: benefit.access,
          pricing: {
            mode: benefit.pricing.mode,
            ...(benefit.pricing.discountBps == null
              ? {}
              : { discountBps: benefit.pricing.discountBps }),
            ...(benefit.pricing.customPriceCents == null
              ? {}
              : { customPriceCents: benefit.pricing.customPriceCents }),
          },
          includedQuantity: benefit.includedQuantity,
          periodUnit: period ? (benefit.period?.unit ?? null) : null,
          used,
          remaining: used === null ? null : Math.max(0, benefit.includedQuantity - used),
          periodStart: period?.start ?? null,
          renewsAt: period?.end ?? null,
          exhaustion: benefit.exhaustion,
        };
      }),
    };
  });
  await audit(req, "viewed", "MemberBenefits", String(member._id), String(member._id));
  return {
    at,
    usage: USAGE_TRACKED,
    clinicianChatAllowed: clinicianChatAllowed(snapshot.plans, rows.map(toHolding), at),
    memberships,
  };
}
