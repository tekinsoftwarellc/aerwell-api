// Status transitions and cancellation. Ledger effects: complete consumes,
// no-show forfeits (consumes), eligible cancel releases, late unwaived cancel
// forfeits the unit (the unit replaces the late fee).
import type { Request } from "express";
import type { ClientSession } from "mongoose";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../common/errors/AppError.js";
import { actor } from "../../common/http.js";
import { audit } from "../audit/audit.js";
import { Member, MemberFlag } from "../member/member.model.js";
import { permissionsOf } from "../member/member.scope.js";
import { permits } from "../role/permission.js";
import { Service } from "../service/service.model.js";
import { emitVisitSignal } from "../visit/visit.events.js";
import {
  AllowanceLedgerEntry,
  Appointment,
  type AppointmentDocument,
  type AppointmentStatus,
  AssessmentEpisode,
} from "./appointment.model.js";
import { appointmentTarget, lockedTransaction } from "./booking.service.js";
import { ledger, memberLock, providerLock } from "./ledger.service.js";

export const TRANSITIONS: Partial<Record<AppointmentStatus, AppointmentStatus[]>> = {
  booked: ["confirmed", "checked_in", "no_show"],
  confirmed: ["checked_in", "no_show"],
  checked_in: ["in_progress", "completed"],
  in_progress: ["completed"],
};
const CANCELLABLE: AppointmentStatus[] = ["booked", "confirmed", "checked_in", "in_progress"];
const HOUR = 3_600_000;

async function transition(
  req: Request,
  row: AppointmentDocument,
  to: AppointmentStatus,
  session: ClientSession,
  extra: Record<string, unknown> = {}
) {
  // Conditional on the status we validated: a concurrent writer makes this miss.
  const updated = await Appointment.findOneAndUpdate(
    { _id: row._id, status: row.status },
    {
      $set: { status: to, ...extra },
      $push: { statusHistory: { status: to, at: new Date(), byId: actor(req)._id } },
    },
    { session, new: true }
  );
  if (!updated)
    throw new ConflictError(
      "This appointment changed; reload and try again",
      undefined,
      "STATUS_CHANGED"
    );
  return updated;
}

/** First completed component consumes the episode's unit; the last one closes it. */
async function fulfilEpisode(req: Request, row: AppointmentDocument, session: ClientSession) {
  if (!row.episodeId) return;
  const episode = await AssessmentEpisode.findOneAndUpdate(
    { _id: row.episodeId, status: "open" },
    { $addToSet: { fulfilledServiceIds: row.serviceId } },
    { session, new: true }
  );
  if (!episode) return;
  await ledger.settle(
    { episodeId: episode._id },
    "consumed",
    String(actor(req)._id),
    "component_completed",
    session
  );
  const done = episode.componentServiceIds.every((id) =>
    episode.fulfilledServiceIds.some((f) => String(f) === String(id))
  );
  if (done && episode.status === "open") {
    episode.set({ status: "completed", completedAt: new Date() });
    await episode.save({ session });
  }
}

async function recordNoShow(row: AppointmentDocument, session: ClientSession) {
  await MemberFlag.create(
    [
      {
        organizationId: row.organizationId,
        memberId: row.memberId,
        category: "attendance",
        title: "Missed Appointment - No Show",
        severity: "urgent",
        relatedServiceId: row.serviceId,
        raisedBy: "system",
      },
    ],
    { session }
  );
}

/** W9 visit timestamps: the visit starts at in_progress and ends at completion. */
function visitFields(row: AppointmentDocument, to: AppointmentStatus) {
  if (to === "in_progress") return { visit: { startedAt: new Date() } };
  if (to === "completed" && row.visit?.startedAt) return { "visit.endedAt": new Date() };
  return {};
}

export async function changeStatus(req: Request) {
  const to = (req.body as { status: AppointmentStatus }).status;
  const initial = await appointmentTarget(req);
  const updated = await lockedTransaction(
    [memberLock(initial.memberId), providerLock(initial.providerId)],
    async (session) => {
      const row = await Appointment.findById(initial._id).session(session);
      if (!row) throw new NotFoundError("Appointment not found");
      if (!TRANSITIONS[row.status as AppointmentStatus]?.includes(to))
        throw new ValidationError(
          `A ${row.status} appointment cannot become ${to}`,
          "INVALID_STATUS_TRANSITION"
        );
      const updated = await transition(req, row, to, session, visitFields(row, to));
      const staffId = String(actor(req)._id);
      if (to === "completed") {
        await ledger.settle({ appointmentId: row._id }, "consumed", staffId, "completed", session);
        await fulfilEpisode(req, updated, session);
        await Member.updateOne(
          { _id: row.memberId },
          { $max: { lastVisitAt: row.startAt } },
          { session }
        );
      }
      if (to === "no_show") {
        await ledger.settle({ appointmentId: row._id }, "consumed", staffId, "no_show", session);
        // A missed assessment component forfeits the episode's shared unit too.
        if (row.episodeId)
          await ledger.settle(
            { episodeId: row.episodeId },
            "consumed",
            staffId,
            "component_no_show",
            session
          );
        await recordNoShow(row, session);
      }
      await audit(
        req,
        `status_${to}`,
        "Appointment",
        String(row._id),
        String(row.memberId),
        session
      );
      return updated;
    }
  );
  // Any live transcription of this appointment stops once it leaves in_progress.
  if (to !== "in_progress") emitVisitSignal(String(initial._id), "visit_ended");
  return updated;
}

/** Late-cancellation terms for one appointment at `now` (also shown before cancelling). */
export async function cancellationTerms(
  row: AppointmentDocument,
  now = new Date(),
  session: ClientSession | null = null
) {
  const service = await Service.findById(row.serviceId)
    .select("lateCancellationFee")
    .session(session)
    .lean();
  const policy = service?.lateCancellationFee;
  const late =
    Boolean(policy?.enabled) &&
    row.startAt.getTime() - now.getTime() < (policy?.windowHours ?? 24) * HOUR;
  const held = await AllowanceLedgerEntry.exists({
    appointmentId: row._id,
    status: "reserved",
  }).session(session);
  return {
    late,
    windowHours: policy?.windowHours ?? 24,
    allowanceHeld: Boolean(held),
    // A forfeited unit replaces the fee; a paid booking records the fee as due.
    feeCents: late && !held ? (policy?.amountCents ?? 0) : 0,
    forfeitsAllowance: late && Boolean(held),
  };
}

async function applyCancellation(
  req: Request,
  row: AppointmentDocument,
  input: { reason: string; waiveFee: boolean },
  session: ClientSession
) {
  const terms = await cancellationTerms(row, new Date(), session);
  // Once the member has checked in, the visit is being delivered: the unit is used.
  const started = ["checked_in", "in_progress"].includes(row.status);
  const forfeit = started || (terms.forfeitsAllowance && !input.waiveFee);
  const feeCents = input.waiveFee ? 0 : terms.feeCents;
  const settled = await ledger.settle(
    { appointmentId: row._id },
    forfeit ? "consumed" : "released",
    String(actor(req)._id),
    forfeit ? "late_cancellation" : "cancelled",
    session
  );
  const allowance = forfeit ? "forfeited" : "released";
  return transition(req, row, "cancelled", session, {
    cancellation: {
      at: new Date(),
      byId: actor(req)._id,
      reason: input.reason,
      late: terms.late,
      feeCents,
      feeWaived: input.waiveFee && terms.late,
      allowance: settled ? allowance : "none",
    },
    amountDueCents: feeCents,
    paymentStatus: feeCents > 0 ? "unconfigured" : "not_required",
  });
}

export async function cancelAppointment(req: Request) {
  const { reason, waiveFee = false } = req.body as { reason: string; waiveFee?: boolean };
  if (waiveFee && !permits((await permissionsOf(req)).APPOINTMENTS.level, "master"))
    throw new ForbiddenError("Waiving a fee needs Appointments master", "WAIVE_REQUIRES_MASTER");
  const initial = await appointmentTarget(req);
  const cancelled = await lockedTransaction(
    [memberLock(initial.memberId), providerLock(initial.providerId)],
    async (session) => {
      const row = await Appointment.findById(initial._id).session(session);
      if (!(row && CANCELLABLE.includes(row.status as AppointmentStatus)))
        throw new ValidationError(
          "This appointment cannot be cancelled",
          "INVALID_STATUS_TRANSITION"
        );
      const updated = await applyCancellation(req, row, { reason, waiveFee }, session);
      await audit(req, "cancelled", "Appointment", String(row._id), String(row.memberId), session);
      return updated;
    }
  );
  emitVisitSignal(String(initial._id), "visit_ended");
  return cancelled;
}
