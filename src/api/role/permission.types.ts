export const MODULES = [
  "MEMBER_RECORDS",
  "CLINICAL_NOTES",
  "LABS_SCANS",
  "PROTOCOLS",
  "BILLING",
  "STAFF_RECORDS",
  "SYSTEM_SETTINGS",
  "SERVICES",
  "APPOINTMENTS",
] as const;
export type PermissionModule = (typeof MODULES)[number];
export type PermissionLevel = "none" | "view" | "edit" | "master";
export interface Permission {
  module: PermissionModule;
  level: PermissionLevel;
  scope: "all" | "own";
}
export type EffectivePermissions = Record<PermissionModule, Omit<Permission, "module">>;
