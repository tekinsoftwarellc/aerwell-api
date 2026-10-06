import mongoose from "mongoose";
import { expect, it } from "vitest";
import { Member } from "../api/member/member.model.js";
import { dropRetiredIndexes, syncAllIndexes } from "./indexes.js";

it("retires the old full unique email index so members without an email can be stored", async () => {
  await Member.collection.createIndex(
    { organizationId: 1, email: 1 },
    { name: "organizationId_1_email_1", unique: true }
  );
  const names = async () => (await Member.collection.indexes()).map((i) => i.name);
  expect(await names()).toContain("organizationId_1_email_1");
  await syncAllIndexes();
  const after = await names();
  expect(after).not.toContain("organizationId_1_email_1");
  expect(after).toContain("organizationId_1_email_1_partial");
  // A fresh database has nothing to drop.
  await expect(dropRetiredIndexes()).resolves.toBeUndefined();
  expect(mongoose.connection.readyState).toBe(1);
});
