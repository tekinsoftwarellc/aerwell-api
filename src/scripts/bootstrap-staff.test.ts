import { describe, expect, it } from "vitest";
import { StaffCredential } from "../api/auth/auth.model.js";
import { loginStaff } from "../api/auth/auth.service.js";
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

describe("bootstrapStaff", () => {
  it("creates settings, Super Admin role, active super-admin staff and credential on an empty DB", async () => {
    expect(await bootstrapStaff(input)).toEqual({
      createdStaff: true,
      createdSettings: true,
      createdRole: true,
    });
    const role = await Role.findOne({ organizationId: input.organizationId }).lean();
    expect(role?.name).toBe("Super Admin");
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
      createdSettings: false,
      createdRole: false,
    });
    expect(await StaffMember.countDocuments()).toBe(1);
    expect(await StaffCredential.countDocuments()).toBe(1);
    expect(await Role.countDocuments()).toBe(1);
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
});
