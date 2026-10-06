// Transactional allowance ledger. Callers hold the member booking lock and a
// transaction session, so "count then reserve" cannot interleave for one member.
import type { ClientSession, Types } from "mongoose";
import { ConflictError } from "../../common/errors/AppError.js";
import type { AllowanceState, PlanConfig, Selection } from "../entitlement/entitlement.types.js";
import type { MembershipHolding } from "../entitlement/entitlement.types.js";
import { benefitPeriod, usageKey } from "../entitlement/evaluate.js";
import { AllowanceLedgerEntry, BookingLock } from "./appointment.model.js";

type Id = Types.ObjectId | string;
export interface LedgerTarget {
  appointmentId?: Id | null;
  episodeId?: Id | null;
}

/** Idempotent lock creation outside the transaction (an upsert inside one can race). */
export async function ensureLocks(keys: string[]) {
  for (const key of keys)
    await BookingLock.updateOne({ _id: key }, { $setOnInsert: { revision: 0 } }, { upsert: true });
}
/** Inside the transaction: concurrent holders of the same key write-conflict and retry. */
export async function takeLocks(keys: string[], session: ClientSession) {
  for (const key of [...keys].sort())
    await BookingLock.updateOne({ _id: key }, { $inc: { revision: 1 } }, { session });
}
export const memberLock = (memberId: Id) => `member:${String(memberId)}`;
export const providerLock = (providerId: Id) => `provider:${String(providerId)}`;
/** One machine or room: two members with two providers must still queue for it. */
export const environmentLock = (environmentId: Id) => `environment:${String(environmentId)}`;

// Exported as an object so the race tests can spy on what each writer attempted.
export const ledger = {
  /**
   * Units held (reserved or consumed) per usageKey in the period that contains
   * `at`, for every current membership benefit with an allowance.
   */
  async usage(
    organizationId: string,
    memberId: Id,
    holdings: MembershipHolding[],
    plans: PlanConfig[],
    at: Date,
    exclude: LedgerTarget,
    session: ClientSession | null
  ): Promise<Record<string, number>> {
    const rows = await AllowanceLedgerEntry.find({
      organizationId,
      memberId,
      holding: true,
      ...(exclude.appointmentId ? { appointmentId: { $ne: exclude.appointmentId } } : {}),
      ...(exclude.episodeId ? { episodeId: { $ne: exclude.episodeId } } : {}),
    })
      .select("membershipId benefitId periodStart periodEnd quantity")
      .session(session)
      .lean();
    const usage: Record<string, number> = {};
    for (const holding of holdings) {
      const plan = plans.find((p) => p.id === holding.planId);
      for (const benefit of plan?.benefits ?? []) {
        if (!benefit.period || benefit.includedQuantity <= 0) continue;
        const { start, end } = benefitPeriod(holding.startedAt, benefit.period, at);
        usage[usageKey(holding.id, benefit.id)] = rows
          .filter(
            (r) =>
              String(r.membershipId) === holding.id &&
              r.benefitId === benefit.id &&
              // Overlap, not equality: a period-policy edit must not orphan held units.
              r.periodStart < end &&
              r.periodEnd > start
          )
          .reduce((sum, r) => sum + r.quantity, 0);
      }
    }
    return usage;
  },

  async reserve(
    input: {
      organizationId: string;
      memberId: Id;
      serviceId: Id;
      selection: Selection;
      allowance: AllowanceState;
      actorId: string;
      target: LedgerTarget;
    },
    session: ClientSession
  ) {
    const { selection, allowance, target } = input;
    try {
      const [row] = await AllowanceLedgerEntry.create(
        [
          {
            organizationId: input.organizationId,
            memberId: input.memberId,
            membershipId: allowance.membershipId,
            planId: selection.planId,
            benefitId: allowance.benefitId,
            serviceId: input.serviceId,
            appointmentId: target.appointmentId ?? null,
            episodeId: target.episodeId ?? null,
            periodStart: allowance.periodStart,
            periodEnd: allowance.periodEnd,
            events: [{ status: "reserved", at: new Date(), actorId: input.actorId }],
          },
        ],
        { session }
      );
      return row;
    } catch (error) {
      if ((error as { code?: number }).code === 11000)
        throw new ConflictError(
          "This booking already holds an allowance unit",
          undefined,
          "ALLOWANCE_ALREADY_HELD"
        );
      throw error;
    }
  },

  /** reserved -> consumed | released; a no-op when nothing is reserved (idempotent). */
  async settle(
    target: LedgerTarget,
    to: "consumed" | "released",
    actorId: string,
    reason: string,
    session: ClientSession
  ) {
    const filter = target.appointmentId
      ? { appointmentId: target.appointmentId }
      : { episodeId: target.episodeId };
    return AllowanceLedgerEntry.findOneAndUpdate(
      { ...filter, status: "reserved" },
      {
        $set: { status: to, holding: to === "consumed" },
        $push: { events: { status: to, at: new Date(), actorId, reason } },
      },
      { session, new: true }
    );
  },
};
