import { z } from "zod";
import { StaffCredential } from "../api/auth/auth.model.js";
import { emailSchema, passwordSchema } from "../api/auth/auth.schema.js";
import { hashPassword } from "../api/auth/password.js";
import { Environment, Location } from "../api/location/location.model.js";
import { MODULES, seedRoles } from "../api/role/permission.js";
import { Role } from "../api/role/role.model.js";
import { OrganizationSettings } from "../api/settings/settings.model.js";
import { StaffMember } from "../api/staff/staff.model.js";

/** A refused input or rerun: its message names fields only, never values, so the CLI may log it. */
export class BootstrapInputError extends Error {
  override name = "BootstrapInputError";
}

// Same environments seed.service.ts creates for a location.
const LOCATION_ENVIRONMENTS = ["The Clinic", "The Reserve"];

const required = z.string().trim().min(1);
const coordinate = (limit: number) => required.pipe(z.coerce.number().min(-limit).max(limit));
const timeZoneSchema = required.refine((timeZone) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}, "Unknown IANA time zone");
const locationInputSchema = z
  .object({
    name: required,
    timeZone: timeZoneSchema,
    lat: coordinate(90),
    lng: coordinate(180),
    line1: required,
    city: required,
    region: required,
    postalCode: required,
    country: required,
  })
  .strict();

// Production-safe first staff: organization settings, the role templates (Super Admin plus
// seedRoles) and one active super-admin with a password; optionally the first location and its
// environments. No catalog or demo data (seed:dev does that).
const bootstrapInputSchema = z
  .object({
    organizationId: z.string().min(1),
    email: emailSchema,
    firstName: z.string().trim().min(1),
    lastName: z.string().trim().min(1),
    password: passwordSchema.refine(
      (v) => !(/^\s/.test(v) || /\s$/.test(v)),
      "password must not start or end with whitespace"
    ),
    location: locationInputSchema.optional(),
  })
  .strict();
export type BootstrapInput = z.input<typeof bootstrapInputSchema>;

/** Reads the CLI input from env; throws a one-line reason (the CLI exits 1 on it). */
export function bootstrapInputFromEnv(source: Record<string, string | undefined>): BootstrapInput {
  const organizationId = source["AERWELL_ORG_ID"];
  if (!organizationId) throw new BootstrapInputError("AERWELL_ORG_ID is required");
  const locationName = source["BOOTSTRAP_LOCATION_NAME"];
  return {
    organizationId,
    email: source["BOOTSTRAP_STAFF_EMAIL"] ?? "",
    firstName: source["BOOTSTRAP_STAFF_FIRST_NAME"] ?? "",
    lastName: source["BOOTSTRAP_STAFF_LAST_NAME"] ?? "",
    password: source["BOOTSTRAP_STAFF_PASSWORD"] ?? "",
    // All BOOTSTRAP_LOCATION_* are required once the name is set; unset name skips the step.
    ...(locationName
      ? {
          location: {
            name: locationName,
            timeZone: source["BOOTSTRAP_LOCATION_TIMEZONE"] ?? "",
            lat: source["BOOTSTRAP_LOCATION_LAT"] ?? "",
            lng: source["BOOTSTRAP_LOCATION_LNG"] ?? "",
            line1: source["BOOTSTRAP_LOCATION_LINE1"] ?? "",
            city: source["BOOTSTRAP_LOCATION_CITY"] ?? "",
            region: source["BOOTSTRAP_LOCATION_REGION"] ?? "",
            postalCode: source["BOOTSTRAP_LOCATION_POSTAL_CODE"] ?? "",
            country: source["BOOTSTRAP_LOCATION_COUNTRY"] ?? "",
          },
        }
      : {}),
  };
}

const upsertOptions = { upsert: true, new: true, includeResultMetadata: true } as const;

/** Location + environments as seed.service.ts builds them; never overwrites an existing location. */
async function bootstrapLocation(
  organizationId: string,
  location: z.output<typeof locationInputSchema>
) {
  const { name, timeZone, lat, lng, line1, city, region, postalCode, country } = location;
  const result = await Location.findOneAndUpdate(
    { organizationId, name },
    {
      $setOnInsert: {
        organizationId,
        name,
        timeZone,
        address: `${line1}, ${city}, ${region} ${postalCode}, ${country}`,
        geo: { type: "Point", coordinates: [lng, lat] },
      },
    },
    upsertOptions
  );
  const row = result.value;
  if (!row) throw new Error("location upsert returned no document");
  await OrganizationSettings.updateOne(
    { organizationId, primaryLocationId: { $exists: false } },
    { $set: { primaryLocationId: row._id } }
  );
  for (const environment of LOCATION_ENVIRONMENTS)
    await Environment.updateOne(
      { organizationId, locationId: row._id, name: environment },
      { $setOnInsert: { organizationId, locationId: row._id, name: environment } },
      { upsert: true }
    );
  return { row, created: !result.lastErrorObject?.updatedExisting };
}

export async function bootstrapStaff(input: BootstrapInput) {
  const parsed = bootstrapInputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new BootstrapInputError(
      `${issue?.path.join(".") || "input"}: ${issue?.message ?? "invalid"}`
    );
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
  const location = data.location ? await bootstrapLocation(organizationId, data.location) : null;
  for (const template of seedRoles)
    await Role.updateOne(
      { organizationId, name: template.name },
      { $setOnInsert: { organizationId, ...template } },
      { upsert: true }
    );
  const role = await Role.findOneAndUpdate(
    { organizationId, name: "Super Admin" },
    {
      $setOnInsert: {
        organizationId,
        name: "Super Admin",
        shortCode: "SA",
        permissions: MODULES.map((module) => ({ module, level: "master", scope: "all" })),
      },
    },
    upsertOptions
  );
  const staff = await StaffMember.findOneAndUpdate(
    { organizationId, email: data.email },
    {
      $setOnInsert: {
        organizationId,
        email: data.email,
        firstName: data.firstName,
        lastName: data.lastName,
        roleId: role.value?._id,
        isSuperAdmin: true,
        accountStatus: "active",
        ...(location ? { homeLocationId: location.row._id } : {}),
      },
    },
    upsertOptions
  );
  const staffRow = staff.value;
  // A rerun must not report success for a staff member who cannot sign in.
  if (
    !staffRow ||
    staffRow.accountStatus !== "active" ||
    staffRow.isSuperAdmin !== true ||
    staffRow.deletedAt != null
  )
    throw new BootstrapInputError(
      "existing staff for BOOTSTRAP_STAFF_EMAIL is not an active super-admin (accountStatus active, isSuperAdmin true, deletedAt null); fix it in the database first"
    );
  // Never overwrites an existing password: a rerun cannot reset a staff member's credential.
  const credential = await StaffCredential.updateOne(
    { staffId: staffRow._id },
    {
      $setOnInsert: {
        staffId: staffRow._id,
        organizationId,
        passwordHash: await hashPassword(data.password),
      },
    },
    { upsert: true }
  );
  return {
    createdStaff: !staff.lastErrorObject?.updatedExisting,
    createdCredential: credential.upsertedCount === 1,
    createdSettings: settings.upsertedCount === 1,
    createdRole: !role.lastErrorObject?.updatedExisting,
    createdLocation: location?.created ?? false,
    locationId: location ? String(location.row._id) : null,
  };
}
