import type { Request } from "express";
import mongoose, { type ClientSession } from "mongoose";
import { actor } from "../../common/http.js";
import { AuditEvent } from "../audit/audit.js";
import { OrganizationSettings } from "../settings/settings.model.js";
export async function schedulingTransaction<T>(
  req: Request,
  work: (session: ClientSession) => Promise<T>
) {
  const organizationId = actor(req).organizationId;
  await OrganizationSettings.updateOne(
    { organizationId },
    { $setOnInsert: { organizationId } },
    { upsert: true }
  );
  return mongoose.connection.transaction(async (session) => {
    // Shared write serializes conflict predicates across shifts and PTO approvals.
    await OrganizationSettings.updateOne(
      { organizationId },
      { $inc: { scheduleRevision: 1 } },
      { session }
    );
    return work(session);
  });
}
export async function scheduleAudit(
  req: Request,
  session: ClientSession,
  action: string,
  targetType: string,
  targetId: string
) {
  await AuditEvent.create(
    [
      {
        organizationId: actor(req).organizationId,
        actorId: String(actor(req)._id),
        action,
        targetType,
        targetId,
        requestId: req.requestId,
      },
    ],
    { session, ordered: true }
  );
}
