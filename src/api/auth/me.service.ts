import { resolvePermissions } from "../role/permission.js";
import { Role } from "../role/role.model.js";
import { OrganizationSettings } from "../settings/settings.model.js";
import type { StaffDocument } from "../staff/staff.model.js";
export async function getMe(staff: StaffDocument) {
  const [permissions, role, organization] = await Promise.all([
    resolvePermissions(staff),
    Role.findOne({ _id: staff.roleId, organizationId: staff.organizationId }),
    OrganizationSettings.findOne({ organizationId: staff.organizationId }),
  ]);
  return {
    id: String(staff._id),
    firstName: staff.firstName,
    lastName: staff.lastName,
    email: staff.email,
    avatarUrl: staff.photoUrl,
    isSuperAdmin: staff.isSuperAdmin,
    roleLabel: staff.isSuperAdmin ? "Super Admin" : (role?.name ?? "Staff"),
    permissions,
    visibleModules: Object.entries(permissions)
      .filter(([, v]) => v.level !== "none")
      .map(([key]) => key),
    organization: {
      name: organization?.name ?? "Aerwell",
      timeZone: organization?.timeZone ?? "America/Los_Angeles",
      logoUrl: organization?.logoUrl,
    },
    security: { autoSignOutMinutes: organization?.security?.autoSignOutMinutes ?? 30 },
  };
}
