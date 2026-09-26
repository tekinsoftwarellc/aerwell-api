import { expect, it } from "vitest";
import { Environment, Location } from "../api/location/location.model.js";
import { Role } from "../api/role/role.model.js";
import { OrganizationSettings } from "../api/settings/settings.model.js";
import { StaffMember } from "../api/staff/staff.model.js";
import { seedDevelopmentData } from "./seed.service.js";
it("seeds Aerwell defaults idempotently without reactivating or changing existing staff", async () => {
  const input = {
    organizationId: "org-seed",
    email: "first@example.invalid",
    password: "Seed-test-passphrase!9",
    firstName: "Seed",
    lastName: "Admin",
  };
  await seedDevelopmentData(input);
  await seedDevelopmentData(input);
  expect(await Role.countDocuments()).toBe(6);
  expect(await StaffMember.countDocuments()).toBe(1);
  expect(await Location.countDocuments()).toBe(1);
  expect(await Environment.countDocuments()).toBe(2);
  expect(await OrganizationSettings.findOne().lean()).toMatchObject({
    name: "Aerwell",
    timeZone: "America/Los_Angeles",
    security: { requireTwoFactor: false },
  });
  await StaffMember.updateOne(
    { organizationId: input.organizationId },
    { $set: { accountStatus: "deactivated" } }
  );
  await seedDevelopmentData(input);
  expect((await StaffMember.findOne())?.accountStatus).toBe("deactivated");
});
it("puts the seeded Las Vegas clinic in the Las Vegas market once, never over a staff edit", async () => {
  const { Market } = await import("../api/catalog/catalog.model.js");
  const input = {
    organizationId: "org-seed",
    email: "market@example.invalid",
    password: "Seed-test-passphrase!9",
    firstName: "Seed",
    lastName: "Admin",
  };
  await seedDevelopmentData(input);
  await seedDevelopmentData(input);
  const clinic = await Location.findOne({ name: "Aerwell Las Vegas" }).lean();
  const market = await Market.findOne({ slug: "las-vegas" }).lean();
  expect(market?.locationIds.map(String)).toEqual([String(clinic?._id)]);
  // A market staff have already configured is left alone.
  await Market.updateOne({ slug: "las-vegas" }, { $set: { locationIds: [] } });
  const other = await Location.create({ organizationId: "org-seed", name: "Other clinic" });
  await Market.updateOne({ slug: "las-vegas" }, { $set: { locationIds: [other._id] } });
  await seedDevelopmentData(input);
  expect((await Market.findOne({ slug: "las-vegas" }).lean())?.locationIds.map(String)).toEqual([
    String(other._id),
  ]);
});
