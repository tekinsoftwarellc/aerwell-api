import type { ClientSession } from "mongoose";
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
 * to send. Grants are open-ended and a cancel ends Alfred benefits at once, so periodEnd is never sent.
 */
export const buildPlanGrant = async (m: MembershipLike): Promise<PlanGrantBody | null> => {
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
    periodEnd: null,
    eventId: `mm:${String(m._id)}:${status}:${stamp}`,
  };
};

/**
 * Record one staff membership change for Alfred, inside the caller's transaction so the change
 * and its outbox row commit or roll back together. No-op until ALFRED_PLAN_GRANTS_ENABLED.
 * Upsert on eventId (a duplicate key would abort the transaction); delivery retries from Mongo.
 * Rows that came from Alfred (`source: "alfred"`) are never passed here (echo rule).
 */
export const enqueuePlanGrant = async (
  m: MembershipLike,
  session: ClientSession
): Promise<"queued" | "duplicate" | "skipped"> => {
  if (env.ALFRED_PLAN_GRANTS_ENABLED !== "true") return "skipped";
  const body = await buildPlanGrant(m);
  if (!body) return "skipped";
  const res = await PlanGrantOutbox.updateOne(
    { eventId: body.eventId },
    {
      $setOnInsert: {
        eventId: body.eventId,
        body,
        status: "pending",
        attempts: 0,
        nextAttemptAt: new Date(),
      },
    },
    { upsert: true, session }
  );
  return res.upsertedCount ? "queued" : "duplicate";
};
