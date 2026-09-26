import type { EffectivePermissions, Permission } from "../../api/role/permission.types.js";
import type { StaffDocument } from "../../api/staff/staff.model.js";
declare global {
  namespace Express {
    interface Request {
      staff?: StaffDocument;
      permissions?: EffectivePermissions;
      permission?: Omit<Permission, "module">;
    }
  }
}
