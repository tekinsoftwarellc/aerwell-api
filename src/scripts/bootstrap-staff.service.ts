import { z } from "zod";
import { StaffCredential } from "../api/auth/auth.model.js";
import { emailSchema, passwordSchema } from "../api/auth/auth.schema.js";
import { hashPassword } from "../api/auth/password.js";
import { MODULES } from "../api/role/permission.js";
import { Role } from "../api/role/role.model.js";
import { OrganizationSettings } from "../api/settings/settings.model.js";
import { StaffMember } from "../api/staff/staff.model.js";

// Production-safe first staff: organization settings, the Super Admin role and one active
// super-admin with a password. No location, catalog, environment or demo data (seed:dev does that).
const bootstrapInputSchema = z
  .object({
    organizationId: z.string().min(1),
    email: emailSchema,
    firstName: z.string().trim().min(1),
    lastName: z.string().trim().min(1),
    password: passwordSchema,
  })
  .strict();
export type BootstrapInput = z.input<typeof bootstrapInputSchema>;

/** Reads the CLI input from env; throws a one-line reason (the CLI exits 1 on it). */
export function bootstrapInputFromEnv(source: Record<string, string | undefined>): BootstrapInput {
  const organizationId = source["AERWELL_ORG_ID"];
  if (!organizationId) throw new Error("AERWELL_ORG_ID is required");
  return {
    organizationId,
    email: source["BOOTSTRAP_STAFF_EMAIL"] ?? "",
    firstName: source["BOOTSTRAP_STAFF_FIRST_NAME"] ?? "",
    lastName: source["BOOTSTRAP_STAFF_LAST_NAME"] ?? "",
    password: source["BOOTSTRAP_STAFF_PASSWORD"] ?? "",
  };
}

export async function bootstrapStaff(input: BootstrapInput) {
  const parsed = bootstrapInputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${issue?.path.join(".") || "input"}: ${issue?.message ?? "invalid"}`);
  }
  const data = parsed.data;
  const { organizationId } = data;
  const settings = await OrganizationSettings.updateOne(
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
  const role = await Role.updateOne(
    { organizationId, name: "Super Admin" },
    {
      $setOnInsert: {
        organizationId,
        name: "Super Admin",
        shortCode: "SA",
        permissions: MODULES.map((module) => ({ module, level: "master", scope: "all" })),
      },
    },
    { upsert: true }
  );
  const roleId = (await Role.findOne({ organizationId, name: "Super Admin" }, { _id: 1 }))?._id;
  const staff = await StaffMember.updateOne(
    { organizationId, email: data.email },
    {
      $setOnInsert: {
        organizationId,
        email: data.email,
        firstName: data.firstName,
        lastName: data.lastName,
        roleId,
        isSuperAdmin: true,
        accountStatus: "active",
      },
    },
    { upsert: true }
  );
  const staffId = (await StaffMember.findOne({ organizationId, email: data.email }, { _id: 1 }))
    ?._id;
  // Never overwrites an existing password: a rerun cannot reset a staff member's credential.
  await StaffCredential.updateOne(
    { staffId },
    {
      $setOnInsert: { staffId, organizationId, passwordHash: await hashPassword(data.password) },
    },
    { upsert: true }
  );
  return {
    createdStaff: staff.upsertedCount === 1,
    createdSettings: settings.upsertedCount === 1,
    createdRole: role.upsertedCount === 1,
  };
}
