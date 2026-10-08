import type { Request, Response } from "express";
import type { z } from "zod";
import { BadRequestError, UnauthorizedError } from "../../common/errors/AppError.js";
import { ServiceResponse } from "../../common/models/serviceResponse.js";
import { env } from "../../config/env.js";
import { Appointment } from "../appointment/appointment.model.js";
import { Member } from "../member/member.model.js";
import { ProductOrder } from "../product/productOrder.model.js";
import { purchaseItem } from "../product/productOrder.view.js";
import { Service } from "../service/service.model.js";
import { readyAppointmentIds } from "./clinicalReport.js";
import { loadRefs, orderItem } from "./partner.bookings.view.js";
import type { ordersQuery } from "./partner.schema.js";
import { afterKeyset, decodeCursor, encodeCursor } from "./partnerCursor.js";

/** The one stream of every kind Aerwell can place in Alfred's orders: visits, clinical visits, product orders. */
const SERVED_KINDS = ["booking", "clinical", "purchase"];
const byKeyset = (a: { updatedAt: Date; _id: unknown }, b: { updatedAt: Date; _id: unknown }) =>
  a.updatedAt.getTime() - b.updatedAt.getTime() || String(a._id).localeCompare(String(b._id));

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
  const common = {
    organizationId,
    memberId: { $in: members.map((m) => m._id) },
    ...(q.updatedSince ? { updatedAt: { $gte: new Date(q.updatedSince) } } : {}),
  };
  const filter = {
    ...common,
    ...(q.kind === "clinical" ? { serviceId: { $in: clinicalIds } } : {}),
    ...(q.kind === "booking" ? { serviceId: { $nin: clinicalIds } } : {}),
  };
  const after = q.cursor ? afterKeyset(decodeCursor(q.cursor)) : null;
  const pageOf = (f: object) => (after ? { $and: [f, after] } : f);
  // Two collections, one keyset: each side returns its own first `limit + 1`, and the merge cuts the page.
  const visits =
    q.kind === "purchase"
      ? []
      : await Appointment.find(pageOf(filter))
          .sort({ updatedAt: 1, _id: 1 })
          .limit(q.limit + 1)
          .lean();
  const purchases =
    q.kind && q.kind !== "purchase"
      ? []
      : await ProductOrder.find(pageOf(common))
          .sort({ updatedAt: 1, _id: 1 })
          .limit(q.limit + 1)
          .lean();
  const merged = [
    ...visits.map((row) => ({
      updatedAt: row.updatedAt,
      _id: row._id,
      kind: "visit" as const,
      row,
    })),
    ...purchases.map((row) => ({
      updatedAt: row.updatedAt,
      _id: row._id,
      kind: "purchase" as const,
      row,
    })),
  ].sort(byKeyset);
  const rows = merged.slice(0, q.limit);
  const last = rows.at(-1);
  const pageVisits = rows.flatMap((r) => (r.kind === "visit" ? [r.row] : []));
  const refs = await loadRefs(pageVisits as never);
  const ready = await readyAppointmentIds(
    organizationId,
    pageVisits.map((row) => row._id)
  );
  res.json(
    ServiceResponse.success("Orders", {
      items: rows.map((r) =>
        r.kind === "visit"
          ? orderItem(r.row as never, accountOf.get(String(r.row.memberId)) ?? "", refs, ready)
          : purchaseItem(r.row as never)
      ),
      nextCursor:
        merged.length > q.limit && last ? encodeCursor(last.updatedAt, String(last._id)) : null,
    })
  );
}
