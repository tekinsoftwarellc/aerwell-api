import { expect, it } from "vitest";
import { AuditEvent, audit } from "./audit.js";
it("appends an immutable event with request actor and target, excluding PHI", async () => {
  const req = {
    staff: { _id: "000000000000000000000001", organizationId: "org-a" },
    requestId: "test-request",
  };
  await audit(
    req as never,
    "viewed",
    "Member",
    "000000000000000000000002",
    "000000000000000000000002"
  );
  const event = await AuditEvent.findOne().lean();
  expect(event).toMatchObject({
    organizationId: "org-a",
    actorId: "000000000000000000000001",
    action: "viewed",
    targetType: "Member",
    requestId: "test-request",
  });
  await expect(
    AuditEvent.updateOne({ _id: event?._id }, { $set: { action: "deleted" } })
  ).rejects.toThrow("append-only");
});
