import type { Request } from "express";
import { type ClientSession, Schema, model } from "mongoose";
const schema = new Schema(
  {
    organizationId: { type: String, required: true, index: true },
    actorId: { type: String, required: true },
    action: { type: String, required: true },
    targetType: { type: String, required: true },
    targetId: { type: String, required: true },
    memberId: String,
    requestId: String,
    occurredAt: { type: Date, default: Date.now, immutable: true },
  },
  { versionKey: false }
);
schema.index({ organizationId: 1, occurredAt: -1, _id: -1 });
schema.index({ organizationId: 1, memberId: 1, occurredAt: -1 });
// Retained indefinitely (at least six years); no TTL and no mutation routes.
for (const operation of [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "replaceOne",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
] as const)
  schema.pre(operation, () => {
    throw new Error("Audit events are append-only");
  });
schema.pre("save", function () {
  if (!this.isNew) throw new Error("Audit events are append-only");
});
export const AuditEvent = model("AuditEvent", schema);
/** `req` may be a real request or a socket's actor context (staff + requestId). */
export async function audit(
  req: Pick<Request, "staff" | "requestId">,
  action: string,
  targetType: string,
  targetId: string,
  memberId?: string,
  session?: ClientSession
): Promise<void> {
  if (!req.staff) throw new Error("Audit actor missing");
  const event = {
    organizationId: req.staff.organizationId,
    actorId: String(req.staff._id),
    action,
    targetType,
    targetId,
    memberId,
    requestId: req.requestId,
  };
  await AuditEvent.create([event], session ? { session } : {});
}
