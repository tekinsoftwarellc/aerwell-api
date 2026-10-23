import { describe, expect, it } from "vitest";
import { StaffCredential } from "../api/auth/auth.model.js";
import { loginStaff } from "../api/auth/auth.service.js";
import { Environment, Location } from "../api/location/location.model.js";
import { seedRoles } from "../api/role/permission.js";
import { Role } from "../api/role/role.model.js";
import { OrganizationSettings } from "../api/settings/settings.model.js";
import { StaffMember } from "../api/staff/staff.model.js";
import { bootstrapInputFromEnv, bootstrapStaff } from "./bootstrap-staff.service.js";

// Staff login is scoped to env.AERWELL_ORG_ID (src/test/setup.ts), as on a deployed task.
const input = {
  organizationId: process.env["AERWELL_ORG_ID"] ?? "",
  email: "First.Admin@example.invalid",
  firstName: "First",
  lastName: "Admin",
  password: "Bootstrap-passphrase!9",
};
const location = {
  name: "Aerwell Las Vegas",
  timeZone: "America/Los_Angeles",
  lat: "36.1147",
  lng: "-115.1728",
  line1: "1 Example Way",
  city: "Las Vegas",
  region: "NV",
  postalCode: "89109",
  country: "US",
};

describe("bootstrapStaff", () => {
  it("creates settings, Super Admin role, active super-admin staff and credential on an empty DB", async () => {
    expect(await bootstrapStaff(input)).toEqual({
      createdStaff: true,
      createdCredential: true,
      createdSettings: true,
      createdRole: true,
      createdLocation: false,
      locationId: null,
    });
    const role = await Role.findOne({
      organizationId: input.organizationId,
      name: "Super Admin",
    }).lean();
    expect(role?.shortCode).toBe("SA");
    expect(await Role.countDocuments()).toBe(seedRoles.length + 1);
    expect(await Location.countDocuments()).toBe(0);
    const staff = await StaffMember.findOne({ organizationId: input.organizationId }).lean();
    expect(staff).toMatchObject({
      email: "first.admin@example.invalid",
      accountStatus: "active",
      isSuperAdmin: true,
    });
    expect(String(staff?.roleId)).toBe(String(role?._id));
    expect(await StaffCredential.countDocuments({ staffId: staff?._id })).toBe(1);
    expect(
      await OrganizationSettings.countDocuments({ organizationId: input.organizationId })
    ).toBe(1);
  });

  it("is idempotent: a second call creates nothing and leaves one staff", async () => {
    await bootstrapStaff(input);
    expect(await bootstrapStaff({ ...input, password: "Another-passphrase!9" })).toEqual({
      createdStaff: false,
      createdCredential: false,
      createdSettings: false,
      createdRole: false,
      createdLocation: false,
      locationId: null,
    });
    expect(await StaffMember.countDocuments()).toBe(1);
    expect(await StaffCredential.countDocuments()).toBe(1);
    expect(await Role.countDocuments()).toBe(seedRoles.length + 1);
  });

  it("the created credential authenticates through the real staff login", async () => {
    await bootstrapStaff(input);
    const result = await loginStaff("first.admin@example.invalid", input.password);
    expect(result).toHaveProperty("accessToken");
    await expect(loginStaff("first.admin@example.invalid", "wrong-passphrase!9")).rejects.toThrow();
  });

  it("rejects an 11-character password with the schema message and writes nothing", async () => {
    await expect(bootstrapStaff({ ...input, password: "Short-pass1" })).rejects.toThrow(
      "Use at least 12 characters"
    );
    expect(await StaffMember.countDocuments()).toBe(0);
  });

  it.each([" Bootstrap-passphrase!9", "Bootstrap-passphrase!9 ", "Bootstrap-passphrase!9\n"])(
    "rejects a password with leading/trailing whitespace (%j) and writes nothing",
    async (password) => {
      await expect(bootstrapStaff({ ...input, password })).rejects.toThrow(
        "password must not start or end with whitespace"
      );
      expect(await StaffMember.countDocuments()).toBe(0);
    }
  );

  it.each([{ accountStatus: "deactivated" }, { isSuperAdmin: false }, { deletedAt: new Date() }])(
    "throws when the existing staff is not an active super-admin (%j)",
    async (patch) => {
      await bootstrapStaff(input);
      await StaffMember.updateOne({}, { $set: patch });
      await expect(bootstrapStaff(input)).rejects.toThrow("is not an active super-admin");
    }
  );

  it("creates the location with geo, address and both environments, idempotently", async () => {
    const first = await bootstrapStaff({ ...input, location });
    expect(first).toMatchObject({ createdLocation: true, locationId: expect.any(String) });
    const row = await Location.findById(first.locationId).lean();
    expect(row).toMatchObject({
      organizationId: input.organizationId,
      name: "Aerwell Las Vegas",
      timeZone: "America/Los_Angeles",
      address: "1 Example Way, Las Vegas, NV 89109, US",
      geo: { type: "Point", coordinates: [-115.1728, 36.1147] },
    });
    const environments = await Environment.find({ locationId: row?._id }).lean();
    expect(environments.map((e) => e.name).sort()).toEqual(["The Clinic", "The Reserve"]);
    const settings = await OrganizationSettings.findOne({
      organizationId: input.organizationId,
    }).lean();
    expect(String(settings?.primaryLocationId)).toBe(first.locationId);
    const staff = await StaffMember.findOne({ organizationId: input.organizationId }).lean();
    expect(String(staff?.homeLocationId)).toBe(first.locationId);

    const second = await bootstrapStaff({ ...input, location: { ...location, city: "Henderson" } });
    expect(second).toMatchObject({ createdLocation: false, locationId: first.locationId });
    expect(await Location.countDocuments()).toBe(1);
    expect(await Environment.countDocuments()).toBe(2);
    expect((await Location.findById(first.locationId).lean())?.address).toContain("Las Vegas");
  });

  it("refuses an incomplete or invalid location and writes no staff", async () => {
    await expect(bootstrapStaff({ ...input, location: { ...location, city: "" } })).rejects.toThrow(
      "location.city"
    );
    await expect(
      bootstrapStaff({ ...input, location: { ...location, lat: "91" } })
    ).rejects.toThrow("location.lat");
    await expect(
      bootstrapStaff({ ...input, location: { ...location, timeZone: "Mars/Base" } })
    ).rejects.toThrow("location.timeZone");
    expect(await StaffMember.countDocuments()).toBe(0);
    expect(await Location.countDocuments()).toBe(0);
  });
});

describe("bootstrapInputFromEnv", () => {
  // Env names as entries: object keys in SCREAMING_CASE trip the naming lint.
  const entries: [string, string][] = [
    ["AERWELL_ORG_ID", input.organizationId],
    ["BOOTSTRAP_STAFF_EMAIL", input.email],
    ["BOOTSTRAP_STAFF_FIRST_NAME", input.firstName],
    ["BOOTSTRAP_STAFF_LAST_NAME", input.lastName],
    ["BOOTSTRAP_STAFF_PASSWORD", input.password],
  ];

  it("reads the input from env", () => {
    expect(bootstrapInputFromEnv(Object.fromEntries(entries))).toEqual(input);
  });

  it("refuses when AERWELL_ORG_ID is unset (CLI exits 1)", () => {
    const withoutOrg = Object.fromEntries(entries.filter(([name]) => name !== "AERWELL_ORG_ID"));
    expect(() => bootstrapInputFromEnv(withoutOrg)).toThrow("AERWELL_ORG_ID is required");
  });

  it("reads BOOTSTRAP_LOCATION_* only when BOOTSTRAP_LOCATION_NAME is set", () => {
    const locationEntries: [string, string][] = [
      ["BOOTSTRAP_LOCATION_NAME", location.name],
      ["BOOTSTRAP_LOCATION_TIMEZONE", location.timeZone],
      ["BOOTSTRAP_LOCATION_LAT", location.lat],
      ["BOOTSTRAP_LOCATION_LNG", location.lng],
      ["BOOTSTRAP_LOCATION_LINE1", location.line1],
      ["BOOTSTRAP_LOCATION_CITY", location.city],
      ["BOOTSTRAP_LOCATION_REGION", location.region],
      ["BOOTSTRAP_LOCATION_POSTAL_CODE", location.postalCode],
      ["BOOTSTRAP_LOCATION_COUNTRY", location.country],
    ];
    expect(bootstrapInputFromEnv(Object.fromEntries([...entries, ...locationEntries]))).toEqual({
      ...input,
      location,
    });
    const withoutName = locationEntries.filter(([name]) => name !== "BOOTSTRAP_LOCATION_NAME");
    expect(bootstrapInputFromEnv(Object.fromEntries([...entries, ...withoutName]))).toEqual(input);
  });
});
