import { Router } from "express";
import { NotFoundError } from "../../common/errors/AppError.js";
import { actor, idParams, secured } from "../../common/http.js";
import { Environment, Location } from "../location/location.model.js";
import { NotificationRule } from "../notification/preference.model.js";
import { Role } from "../role/role.model.js";
import {
  auditQuery,
  preferencesSchema,
  profileSchema,
  regionalSchema,
  rolePatch,
  roleSchema,
  rulePatch,
  ruleSchema,
  securitySchema,
} from "./settings.schema.js";
import {
  listAudit,
  listRoles,
  organizationProfile,
  preferences,
  saveRole,
  saveRule,
  settingsFor,
  updateSettings,
} from "./settings.service.js";
export const settingsRouter = Router();
const view = { module: "SYSTEM_SETTINGS", level: "view" } as const;
const edit = { module: "SYSTEM_SETTINGS", level: "edit" } as const;
const master = { module: "SYSTEM_SETTINGS", level: "master" } as const;
secured(settingsRouter, "get", "/settings/organization", view, {}, organizationProfile);
secured(
  settingsRouter,
  "patch",
  "/settings/organization/profile",
  edit,
  { body: profileSchema },
  (req) => updateSettings(req, "profile")
);
secured(
  settingsRouter,
  "patch",
  "/settings/organization/regional",
  edit,
  { body: regionalSchema },
  (req) => updateSettings(req, "regional")
);
secured(
  settingsRouter,
  "get",
  "/settings/security",
  view,
  {},
  async (req) => (await settingsFor(actor(req).organizationId)).security
);
secured(settingsRouter, "patch", "/settings/security", master, { body: securitySchema }, (req) =>
  updateSettings(req, "security")
);
secured(settingsRouter, "get", "/roles", view, {}, listRoles);
secured(settingsRouter, "post", "/roles", master, { body: roleSchema }, saveRole, 201);
secured(settingsRouter, "get", "/roles/:id", view, { params: idParams }, async (req) => {
  const row = await Role.findOne({
    _id: req.params["id"],
    organizationId: actor(req).organizationId,
  });
  if (!row) throw new NotFoundError();
  return row;
});
secured(
  settingsRouter,
  "patch",
  "/roles/:id",
  master,
  { params: idParams, body: rolePatch },
  saveRole
);
secured(settingsRouter, "get", "/me/notification-preferences", null, {}, (req) => preferences(req));
secured(
  settingsRouter,
  "put",
  "/me/notification-preferences",
  null,
  { body: preferencesSchema },
  (req) => preferences(req, true)
);
secured(settingsRouter, "get", "/notification-rules", view, {}, async (req) =>
  NotificationRule.find({ organizationId: actor(req).organizationId }).lean()
);
secured(settingsRouter, "post", "/notification-rules", edit, { body: ruleSchema }, saveRule, 201);
secured(
  settingsRouter,
  "patch",
  "/notification-rules/:id",
  edit,
  { body: rulePatch, params: idParams },
  saveRule
);
secured(settingsRouter, "get", "/audit-events", view, { query: auditQuery }, listAudit);
secured(settingsRouter, "get", "/locations", null, {}, async (req) =>
  Location.find({ organizationId: actor(req).organizationId }).lean()
);
secured(
  settingsRouter,
  "get",
  "/locations/:id/environments",
  null,
  { params: idParams },
  async (req) => {
    if (
      !(await Location.exists({ _id: req.params["id"], organizationId: actor(req).organizationId }))
    )
      throw new NotFoundError();
    return Environment.find({
      organizationId: actor(req).organizationId,
      locationId: req.params["id"],
    }).lean();
  }
);
