import type { Request, Response } from "express";
import type { z } from "zod";
import { BadRequestError, UnauthorizedError } from "../../common/errors/AppError.js";
import { ServiceResponse } from "../../common/models/serviceResponse.js";
import { env } from "../../config/env.js";
import { Appointment } from "../appointment/appointment.model.js";
import { Member } from "../member/member.model.js";
import { Service } from "../service/service.model.js";
import { readyAppointmentIds } from "./clinicalReport.js";
import { loadRefs, orderItem } from "./partner.bookings.view.js";
import type { ordersQuery } from "./partner.schema.js";
import { afterKeyset, decodeCursor, encodeCursor } from "./partnerCursor.js";

/** The one stream of every kind Aerwell can place in Alfred's orders. Bookings and clinical visits so far. */
const SERVED_KINDS = ["booking", "clinical"];

/**
 * `GET /orders` (§5.10, §8.4): appointments of Alfred-linked members, keyset on `(updatedAt, _id)`.
 * It is the safety net for lost events, so it carries every status including cancelled.
 * ponytail: the linked-member list is read per page; index `alfredAccountId` by id range if it passes ~10k.
 */
export async function listOrders(req: Request, res: Response): Promise<void> {
  const q = req.query as unknown as z.output<typeof ordersQuery>;
  if (q.accountId) {
    if (!req.partner?.accountId)
      throw new UnauthorizedError("Service token is missing the act claim");
    if (q.accountId !== req.partner.accountId)
      throw new BadRequestError("accountId must match the acting member");
  }
  if (!env.AERWELL_ORG_ID) throw new UnauthorizedError("Partner organization is not configured");
  const organizationId = env.AERWELL_ORG_ID;
  const empty = ServiceResponse.success("Orders", { items: [], nextCursor: null });
  if (q.kind && !SERVED_KINDS.includes(q.kind)) {
    res.json(empty);
    return;
  }
  const members = await Member.find({
    organizationId,
    alfredAccountId: q.accountId ?? { $type: "string" },
    alfredUnlinkedAt: null,
  })
    .select("alfredAccountId")
    .lean();
  const accountOf = new Map(members.map((m) => [String(m._id), String(m.alfredAccountId)]));
  // A visit is `clinical` or `booking` by its service's fulfilment, so the kind filter is a service filter.
  const clinicalIds =
    q.kind === "booking" || q.kind === "clinical"
      ? (await Service.find({ organizationId, fulfilment: "clinical" }).select("_id").lean()).map(
          (s) => s._id
        )
      : [];
  const filter = {
    organizationId,
    memberId: { $in: members.map((m) => m._id) },
    ...(q.kind === "clinical" ? { serviceId: { $in: clinicalIds } } : {}),
    ...(q.kind === "booking" ? { serviceId: { $nin: clinicalIds } } : {}),
    ...(q.updatedSince ? { updatedAt: { $gte: new Date(q.updatedSince) } } : {}),
  };
  const rows = await Appointment.find(
    q.cursor ? { $and: [filter, afterKeyset(decodeCursor(q.cursor))] } : filter
  )
    .sort({ updatedAt: 1, _id: 1 })
    .limit(q.limit + 1)
    .lean();
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  const refs = await loadRefs(page as never);
  const ready = await readyAppointmentIds(
    organizationId,
    page.map((row) => row._id)
  );
  res.json(
    ServiceResponse.success("Orders", {
      items: page.map((row) =>
        orderItem(row as never, accountOf.get(String(row.memberId)) ?? "", refs, ready)
      ),
      nextCursor:
        rows.length > q.limit && last ? encodeCursor(last.updatedAt, String(last._id)) : null,
    })
  );
}
