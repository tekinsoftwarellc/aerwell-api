import { logger } from "../../../common/utils/logger.js";
import { env } from "../../../config/env.js";
import { MembershipPlan } from "../../catalog/catalog.model.js";
import { Member } from "../../member/member.model.js";
import { type PlanGrantBody, PlanGrantOutbox } from "./planGrant.model.js";

interface MembershipLike {
  _id: unknown;
  organizationId: string;
  memberId: unknown;
  planId: unknown;
  status: string;
  startedAt: Date;
  endsAt?: Date | null;
  updatedAt: Date;
}

export const planGrantStats = { skippedNoAccount: 0 };

/**
 * Snapshot of one staff membership change as an Alfred plan grant, or null when there is nothing
 * to send. Active rows are open-ended (no periodEnd); a cancel carries one only when it ends later.
 */
export const buildPlanGrant = async (
  m: MembershipLike,
  now = new Date()
): Promise<PlanGrantBody | null> => {
  const [plan, member] = await Promise.all([
    MembershipPlan.findOne({ _id: m.planId, organizationId: m.organizationId })
      .select("slug priceCents")
      .lean(),
    Member.findOne({ _id: m.memberId, organizationId: m.organizationId })
      .select("alfredAccountId")
      .lean(),
  ]);
  if (!plan?.slug || !member) return null;
  if (!member.alfredAccountId) {
    planGrantStats.skippedNoAccount += 1;
    logger.warn(
      { membershipId: String(m._id) },
      "plan grant skipped: member has no alfredAccountId"
    );
    return null;
  }
  const status = m.status === "paused" || m.status === "cancelled" ? m.status : "active";
  // Alfred orders pushes by periodStart; updatedAt moves on every write, so each push wins over the last.
  const stamp = m.updatedAt.getTime();
  return {
    alfredAccountId: member.alfredAccountId,
    tierRef: plan.slug,
    paid: (plan.priceCents ?? 0) > 0,
    status,
    periodStart: m.updatedAt.toISOString(),
    periodEnd: status === "cancelled" && m.endsAt && m.endsAt > now ? m.endsAt.toISOString() : null,
    eventId: `mm:${String(m._id)}:${status}:${stamp}`,
  };
};

/**
 * Record one staff membership change for Alfred. No-op until ALFRED_PLAN_GRANTS_ENABLED.
 * NEVER THROWS: a sync problem must not fail the staff write; delivery is retried from Mongo.
 * Rows that came from Alfred (`source: "alfred"`) are never passed here (echo rule).
 */
export const enqueuePlanGrant = async (
  m: MembershipLike
): Promise<"queued" | "duplicate" | "skipped"> => {
  if (env.ALFRED_PLAN_GRANTS_ENABLED !== "true") return "skipped";
  try {
    const body = await buildPlanGrant(m);
    if (!body) return "skipped";
    try {
      await PlanGrantOutbox.create({ eventId: body.eventId, body });
      return "queued";
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return "duplicate";
      throw err;
    }
  } catch (err) {
    logger.error({ err, membershipId: String(m._id) }, "plan grant enqueue failed");
    return "skipped";
  }
};
