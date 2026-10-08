import { describe, expect, it } from "vitest";
import { AuditEvent, audit } from "./audit.js";

describe("audit with an Alfred partner actor", () => {
  it("records the calling service, scoped to the Aerwell org", async () => {
    await audit(
      { partner: { svc: "alfred-api" }, requestId: "req-1" },
      "created",
      "Appointment",
      "a1",
      "m1"
    );
    const [event] = await AuditEvent.find().lean();
    expect(event).toMatchObject({
      organizationId: "org-test",
      actorId: "partner:alfred-api",
      action: "created",
      targetType: "Appointment",
      memberId: "m1",
    });
  });
  it("still refuses a call with no actor at all", async () => {
    await expect(audit({ requestId: "r" }, "viewed", "Member", "m")).rejects.toThrow(
      "Audit actor missing"
    );
  });
});
