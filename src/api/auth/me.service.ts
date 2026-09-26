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
  const { signedDownload } = await import("../upload/upload.service.js");
  const avatarUrl = staff.photoUploadId
    ? (await signedDownload(String(staff.photoUploadId), staff.organizationId)).url
    : staff.photoUrl;
  const logoUrl = organization?.logoUploadId
    ? (await signedDownload(String(organization.logoUploadId), staff.organizationId)).url
    : organization?.logoUrl;
  return {
    id: String(staff._id),
    firstName: staff.firstName,
    lastName: staff.lastName,
    email: staff.email,
    avatarUrl,
    isSuperAdmin: staff.isSuperAdmin,
    roleLabel: staff.isSuperAdmin ? "Super Admin" : (role?.name ?? "Staff"),
    permissions,
    visibleModules: Object.entries(permissions)
      .filter(([, v]) => v.level !== "none")
      .map(([key]) => key),
    organization: {
      name: organization?.name ?? "Aerwell",
      timeZone: organization?.timeZone ?? "America/Los_Angeles",
      logoUrl,
    },
    security: { autoSignOutMinutes: organization?.security?.autoSignOutMinutes ?? 30 },
  };
}
