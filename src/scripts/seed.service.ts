import { z } from "zod";
import { StaffCredential } from "../api/auth/auth.model.js";
import { passwordSchema } from "../api/auth/auth.schema.js";
import { hashPassword } from "../api/auth/password.js";
import { Market } from "../api/catalog/catalog.model.js";
import { Environment, Location } from "../api/location/location.model.js";
import { MODULES, seedRoles } from "../api/role/permission.js";
import { Role } from "../api/role/role.model.js";
import { seedCatalog } from "../api/service/service.seed.js";
import { OrganizationSettings } from "../api/settings/settings.model.js";
import { StaffMember } from "../api/staff/staff.model.js";
export const seedInputSchema = z
  .object({
    organizationId: z.string().min(1),
    email: z.string().email(),
    password: passwordSchema,
    firstName: z.string().min(1),
    lastName: z.string().min(1),
  })
  .strict();
type SeedInput = z.infer<typeof seedInputSchema>;
async function seedOrganization(organizationId: string) {
  await OrganizationSettings.updateOne(
    { organizationId },
    {
      $setOnInsert: {
        organizationId,
        name: "Aerwell",
        timeZone: "America/Los_Angeles",
        currency: "USD",
        dateFormat: "MM/DD/YYYY",
        security: { autoSignOutMinutes: 30, requireTwoFactor: false },
      },
    },
    { upsert: true }
  );
  const location = await Location.findOneAndUpdate(
    { organizationId, name: "Aerwell Las Vegas" },
    {
      $setOnInsert: { organizationId, name: "Aerwell Las Vegas", timeZone: "America/Los_Angeles" },
    },
    { upsert: true, new: true }
  );
  await OrganizationSettings.updateOne(
    { organizationId, primaryLocationId: { $exists: false } },
    { $set: { primaryLocationId: location._id } }
  );
  // The seeded clinic serves the seeded Las Vegas market (DEXA/VO2 need it);
  // only while the market has no locations, so staff edits are never overwritten.
  await Market.updateOne(
    { organizationId, slug: "las-vegas", locationIds: { $size: 0 } },
    { $set: { locationIds: [location._id] } }
  );
  for (const name of ["The Clinic", "The Reserve"])
    await Environment.updateOne(
      { organizationId, locationId: location._id, name },
      { $setOnInsert: { organizationId, locationId: location._id, name } },
      { upsert: true }
    );
  return location;
}
async function seedRoleTemplates(organizationId: string) {
  for (const role of seedRoles)
    await Role.updateOne(
      { organizationId, name: role.name },
      { $setOnInsert: { organizationId, ...role } },
      { upsert: true }
    );
  return Role.findOneAndUpdate(
    { organizationId, name: "Super Admin" },
    {
      $setOnInsert: {
        organizationId,
        name: "Super Admin",
        shortCode: "SA",
        permissions: MODULES.map((module) => ({ module, level: "master", scope: "all" })),
      },
    },
    { upsert: true, new: true }
  );
}
export async function seedDevelopmentData(input: SeedInput): Promise<void> {
  const data = seedInputSchema.parse(input);
  await seedCatalog(data.organizationId);
  const location = await seedOrganization(data.organizationId);
  const role = await seedRoleTemplates(data.organizationId);
  const staff = await StaffMember.findOneAndUpdate(
    { organizationId: data.organizationId, email: data.email.toLowerCase() },
    {
      $setOnInsert: {
        organizationId: data.organizationId,
        email: data.email.toLowerCase(),
        firstName: data.firstName,
        lastName: data.lastName,
        roleId: role._id,
        isSuperAdmin: true,
        accountStatus: "active",
        homeLocationId: location._id,
      },
    },
    { upsert: true, new: true }
  );
  await StaffCredential.updateOne(
    { staffId: staff._id },
    {
      $setOnInsert: {
        staffId: staff._id,
        organizationId: data.organizationId,
        passwordHash: await hashPassword(data.password),
      },
    },
    { upsert: true }
  );
}
