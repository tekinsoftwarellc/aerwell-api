import { StaffCredential } from "../api/auth/auth.model.js";
import { issueSession } from "../api/auth/session.service.js";
import { seedRoles } from "../api/role/permission.js";
import { Role } from "../api/role/role.model.js";
import { StaffMember } from "../api/staff/staff.model.js";
export async function staffFixture(superAdmin = true, roleIndex = 4) {
  const role = await Role.create({
    ...seedRoles[roleIndex],
    organizationId: "org-test",
    name: `Test role ${Math.random()}`,
  });
  const staff = await StaffMember.create({
    organizationId: "org-test",
    firstName: "Test",
    lastName: "Actor",
    email: `${Math.random()}@example.invalid`,
    accountStatus: "active",
    isSuperAdmin: superAdmin,
    roleId: role._id,
  });
  await StaffCredential.create({
    organizationId: "org-test",
    staffId: staff._id,
    passwordHash: "fixture-not-used-for-login",
  });
  const { accessToken } = await issueSession(String(staff._id), 0);
  return { staff, role, accessToken };
}
