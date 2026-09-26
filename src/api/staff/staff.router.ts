import { Router } from "express";
import { z } from "zod";
import { NotFoundError } from "../../common/errors/AppError.js";
import { actor, idParams, objectId, secured } from "../../common/http.js";
import { audit } from "../audit/audit.js";
import { Role } from "../role/role.model.js";
import { deactivateStaff } from "./deactivate.service.js";
import { StaffFlag, StaffNote } from "./staff-details.model.js";
import {
  bulkDeactivate,
  certificateSchema,
  compensationSchema,
  deactivateSchema,
  employmentSchema,
  permissionPatch,
  staffCreate,
  staffPatch,
  staffQuery,
} from "./staff.schema.js";
import {
  certificates,
  compensation,
  createStaff,
  directory,
  employment,
  permissions,
  staffActivity,
  staffProfile,
  staffTarget,
  updateStaff,
} from "./staff.service.js";
export const staffRouter = Router();
const view = { module: "STAFF_RECORDS", level: "view" } as const;
const edit = { module: "STAFF_RECORDS", level: "edit" } as const;
const master = { module: "STAFF_RECORDS", level: "master" } as const;
secured(staffRouter, "get", "/staff", view, { query: staffQuery }, directory);
secured(staffRouter, "post", "/staff", edit, { body: staffCreate }, createStaff, 201);
secured(staffRouter, "get", "/staff/roles", view, {}, async (req) =>
  Role.find({ organizationId: actor(req).organizationId }).lean()
);
secured(staffRouter, "post", "/staff/bulk/deactivate", master, { body: bulkDeactivate }, (req) =>
  deactivateStaff(req, req.body.ids)
);
secured(staffRouter, "get", "/staff/:id", view, { params: idParams }, staffProfile);
secured(
  staffRouter,
  "patch",
  "/staff/:id",
  edit,
  { params: idParams, body: staffPatch },
  updateStaff
);
secured(
  staffRouter,
  "get",
  "/staff/:id/activity",
  view,
  {
    params: idParams,
    query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).strict(),
  },
  staffActivity
);
secured(
  staffRouter,
  "post",
  "/staff/:id/notes",
  edit,
  { params: idParams, body: z.object({ body: z.string().trim().min(1).max(4000) }).strict() },
  async (req) => {
    const target = await staffTarget(req);
    const row = await StaffNote.create({
      organizationId: target.organizationId,
      staffId: target._id,
      authorId: actor(req)._id,
      body: req.body.body,
    });
    await audit(req, "created", "StaffNote", String(row._id));
    return row;
  },
  201
);
secured(staffRouter, "get", "/staff/:id/employment", view, { params: idParams }, (req) =>
  employment(req)
);
secured(
  staffRouter,
  "patch",
  "/staff/:id/employment",
  edit,
  { params: idParams, body: employmentSchema.partial() },
  (req) => employment(req, true)
);
secured(
  staffRouter,
  "patch",
  "/staff/:id/compensation",
  { module: "BILLING", level: "edit" },
  { params: idParams, body: compensationSchema },
  compensation
);
secured(staffRouter, "get", "/staff/:id/permissions", view, { params: idParams }, (req) =>
  permissions(req)
);
secured(
  staffRouter,
  "put",
  "/staff/:id/permissions",
  master,
  { params: idParams, body: permissionPatch },
  (req) => permissions(req, true)
);
secured(staffRouter, "get", "/staff/:id/certifications", view, { params: idParams }, (req) =>
  certificates(req)
);
secured(
  staffRouter,
  "post",
  "/staff/:id/certifications",
  edit,
  { params: idParams, body: certificateSchema },
  (req) => certificates(req, true),
  201
);
secured(
  staffRouter,
  "patch",
  "/staff/:id/certifications/:certId",
  edit,
  { params: idParams.extend({ certId: objectId }), body: certificateSchema.partial() },
  (req) => certificates(req, true)
);
secured(
  staffRouter,
  "post",
  "/staff/:id/deactivate",
  master,
  { params: idParams, body: deactivateSchema },
  (req) => deactivateStaff(req, [String(req.params["id"])])
);

secured(
  staffRouter,
  "post",
  "/staff/:id/flags",
  edit,
  { params: idParams, body: z.object({ label: z.string().trim().min(1).max(200) }).strict() },
  async (req) => {
    const target = await staffTarget(req);
    const row = await StaffFlag.create({
      organizationId: target.organizationId,
      staffId: target._id,
      label: req.body.label,
      kind: "custom",
    });
    await audit(req, "created", "StaffFlag", String(row._id));
    return row;
  },
  201
);
secured(
  staffRouter,
  "post",
  "/staff/:id/flags/:flagId/resolve",
  edit,
  { params: idParams.extend({ flagId: objectId }) },
  async (req) => {
    const target = await staffTarget(req);
    const row = await StaffFlag.findOneAndUpdate(
      {
        _id: req.params["flagId"],
        staffId: target._id,
        organizationId: target.organizationId,
        kind: "custom",
      },
      { $set: { resolvedAt: new Date() } },
      { new: true }
    );
    if (!row) throw new NotFoundError();
    await audit(req, "resolved", "StaffFlag", String(row._id));
    return row;
  }
);
