import { Router } from "express";
import { z } from "zod";
import { NotFoundError } from "../../../common/errors/AppError.js";
import { actor, idParams, secured } from "../../../common/http.js";
import { audit } from "../../audit/audit.js";
import { OUTBOX_STATUSES, PartnerOutbox } from "./partnerOutbox.model.js";

/**
 * Staff view of the Alfred outbox (R8): if it is stuck, staff changes never reach members' phones.
 * Counts first, then the stuck rows. No payloads are shown, only what is needed to act.
 */
export const partnerOutboxRouter = Router();
const view = { module: "SYSTEM_SETTINGS", level: "view" } as const;
const edit = { module: "SYSTEM_SETTINGS", level: "edit" } as const;
const listQuery = z
  .object({
    status: z.enum(OUTBOX_STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
const STUCK = ["failed", "dead"];

secured(partnerOutboxRouter, "get", "/partner-outbox", view, { query: listQuery }, async (req) => {
  const { organizationId } = actor(req);
  const { status, limit } = req.query as unknown as z.output<typeof listQuery>;
  const [counts, rows] = await Promise.all([
    PartnerOutbox.aggregate<{ _id: string; n: number }>([
      { $match: { organizationId } },
      { $group: { _id: "$status", n: { $sum: 1 } } },
    ]),
    PartnerOutbox.find({ organizationId, status: status ?? { $in: STUCK } })
      .sort({ updatedAt: -1, _id: -1 })
      .limit(limit)
      .select("type status attempts nextAttemptAt lastError lastStatusCode updatedAt resource")
      .lean(),
  ]);
  return {
    counts: Object.fromEntries(
      OUTBOX_STATUSES.map((s) => [s, counts.find((c) => c._id === s)?.n ?? 0])
    ),
    items: rows.map((r) => ({ id: String(r._id), ...r, _id: undefined })),
  };
});

secured(
  partnerOutboxRouter,
  "post",
  "/partner-outbox/:id/retry",
  edit,
  { params: idParams },
  async (req) => {
    const staff = actor(req);
    const row = await PartnerOutbox.findOneAndUpdate(
      { _id: req.params["id"], organizationId: staff.organizationId, status: { $in: STUCK } },
      { $set: { status: "pending", attempts: 0, nextAttemptAt: new Date(), lastError: null } },
      { new: true }
    );
    if (!row) throw new NotFoundError("No failed or dead event with that id");
    await audit(req, "retried", "PartnerOutbox", String(row._id));
    return { id: String(row._id), status: row.status };
  }
);
