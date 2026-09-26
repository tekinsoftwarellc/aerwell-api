import { describe, expect, it } from "vitest";
import { StaffMember } from "../staff/staff.model.js";
import { MODULES, permissionSchema, permits, resolvePermissions, seedRoles } from "./permission.js";
import { Role } from "./role.model.js";

describe("permission contracts", () => {
  it("requires exactly one permission for each module", () => {
    const valid = seedRoles[0]?.permissions ?? [];
    expect(permissionSchema.safeParse(valid).success).toBe(true);
    expect(permissionSchema.safeParse(valid.slice(1)).success).toBe(false);
    expect(permissionSchema.safeParse([...valid.slice(1), valid[1]]).success).toBe(false);
  });
  it.each(seedRoles)("$name resolves every module at allowed and denied levels", async (role) => {
    const saved = await Role.create({ organizationId: "org-a", ...role });
    const staff = await StaffMember.create({
      organizationId: "org-a",
      authAccountId: "account-a",
      firstName: "Example",
      lastName: "User",
      email: "example@test.invalid",
      roleId: saved._id,
      accountStatus: "active",
    });
    const resolved = await resolvePermissions(staff);
    for (const module of MODULES) {
      const expected = role.permissions.find((p) => p.module === module);
      if (!expected) throw new Error("Missing role fixture permission");
      for (const level of ["view", "edit", "master"] as const)
        expect(permits(resolved[module].level, level)).toBe(permits(expected.level, level));
    }
  });
  it("override wins and super admin bypasses; foreign organization roles fail closed", async () => {
    const role = await Role.create({ organizationId: "org-a", ...seedRoles[0] });
    const staff = await StaffMember.create({
      organizationId: "org-a",
      authAccountId: "account-a",
      firstName: "Example",
      lastName: "User",
      email: "example@test.invalid",
      roleId: role._id,
      permissionOverrides: [{ module: "MEMBER_RECORDS", level: "none", scope: "own" }],
    });
    expect((await resolvePermissions(staff)).MEMBER_RECORDS).toEqual({
      level: "none",
      scope: "own",
    });
    staff.isSuperAdmin = true;
    expect((await resolvePermissions(staff)).MEMBER_RECORDS.level).toBe("master");
    staff.isSuperAdmin = false;
    staff.organizationId = "org-b";
    expect((await resolvePermissions(staff)).SERVICES.level).toBe("none");
  });
  it("rejects duplicate staff identity and email within an organization", async () => {
    const row = {
      organizationId: "org-a",
      authAccountId: "account-a",
      firstName: "Example",
      lastName: "User",
      email: "example@test.invalid",
    };
    await StaffMember.init();
    await StaffMember.create(row);
    await expect(StaffMember.create({ ...row, authAccountId: "account-b" })).rejects.toMatchObject({
      code: 11000,
    });
    await expect(StaffMember.create({ ...row, email: "other@test.invalid" })).rejects.toMatchObject(
      { code: 11000 }
    );
  });
});
