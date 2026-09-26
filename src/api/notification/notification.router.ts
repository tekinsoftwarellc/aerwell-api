import type { Request } from "express";
import { Router } from "express";
import { z } from "zod";
import { NotFoundError } from "../../common/errors/AppError.js";
import { actor, idParams, objectId, secured } from "../../common/http.js";
import { Notification } from "./notification.model.js";

// The signed-in staff member's own inbox; no module permission is needed and
// no other inbox is reachable. Rows still inside quiet hours are invisible.
export const notificationRouter = Router();
const listQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: objectId.optional(),
    unread: z.enum(["true", "false"]).optional(),
  })
  .strict();
const visible = (req: Request) => ({
  organizationId: actor(req).organizationId,
  recipientStaffId: actor(req)._id,
  deliverAfter: { $lte: new Date() },
});
export const unreadCount = (req: Request) =>
  Notification.countDocuments({ ...visible(req), readAt: null });

async function list(req: Request) {
  const query = listQuery.parse(req.query);
  const rows = await Notification.find({
    ...visible(req),
    ...(query.unread === "true" ? { readAt: null } : {}),
    ...(query.cursor ? { _id: { $lt: query.cursor } } : {}),
  })
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean();
  const page = rows.slice(0, query.limit);
  return {
    items: page.map((r) => ({
      id: String(r._id),
      kind: r.kind,
      category: r.category,
      title: r.title,
      link: r.link,
      critical: r.critical,
      createdAt: r.createdAt,
      deliveredAt: r.deliverAfter,
      readAt: r.readAt,
    })),
    unreadCount: await unreadCount(req),
    nextCursor: rows.length > query.limit ? String(page.at(-1)?._id) : null,
  };
}
async function markRead(req: Request) {
  const filter = { ...visible(req), _id: req.params["id"] };
  // Conditional: the first read time is kept.
  const hit = await Notification.findOneAndUpdate(
    { ...filter, readAt: null },
    { $set: { readAt: new Date() } }
  );
  if (!(hit || (await Notification.exists(filter)))) throw new NotFoundError();
  return { unreadCount: await unreadCount(req) };
}
async function markAll(req: Request) {
  await Notification.updateMany(
    { ...visible(req), readAt: null },
    { $set: { readAt: new Date() } }
  );
  return { unreadCount: await unreadCount(req) };
}

secured(notificationRouter, "get", "/notifications", null, { query: listQuery }, list);
secured(notificationRouter, "post", "/notifications/read-all", null, {}, markAll);
secured(
  notificationRouter,
  "post",
  "/notifications/:id/read",
  null,
  { params: idParams },
  markRead
);
