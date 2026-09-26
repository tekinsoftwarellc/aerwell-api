import type { Request } from "express";
import { ConflictError, NotFoundError } from "../../common/errors/AppError.js";
import { actor, escapedSearch } from "../../common/http.js";
import { audit } from "../audit/audit.js";
import { Biomarker, LabPanelTemplate } from "./catalog.model.js";
import { referenceLabels, resolveReference } from "./range.js";

// Catalog data is clinic configuration, not PHI: reads are not audited,
// every change is (actor, marker id).
const present = <T extends Parameters<typeof resolveReference>[0]>(marker: T) => ({
  ...marker,
  ...referenceLabels(resolveReference(marker, undefined)),
});
export async function listBiomarkers(req: Request) {
  const { category, q, includeInactive } = req.query as Record<string, string | undefined>;
  const search = q ? new RegExp(escapedSearch(q), "i") : null;
  const rows = await Biomarker.find({
    organizationId: actor(req).organizationId,
    ...(includeInactive === "true" ? {} : { active: true }),
    ...(category ? { category } : {}),
    ...(search ? { $or: [{ name: search }, { shortName: search }, { key: search }] } : {}),
  })
    .sort({ sortOrder: 1, name: 1 })
    .lean();
  return rows.map(present);
}
export async function createBiomarker(req: Request) {
  const organizationId = actor(req).organizationId;
  if (await Biomarker.exists({ organizationId, key: req.body.key }))
    throw new ConflictError("A biomarker with this key exists", undefined, "BIOMARKER_KEY_EXISTS");
  const last = await Biomarker.findOne({ organizationId }).sort({ sortOrder: -1 }).lean();
  const row = await Biomarker.create({
    ...req.body,
    organizationId,
    sortOrder: (last?.sortOrder ?? 0) + 1,
  });
  await audit(req, "created", "Biomarker", String(row._id));
  return present(row.toObject());
}
export async function patchBiomarker(req: Request) {
  const row = await Biomarker.findOne({
    _id: req.params["biomarkerId"],
    organizationId: actor(req).organizationId,
  });
  if (!row) throw new NotFoundError("Biomarker not found");
  // null clears a range; resultType and key are immutable (results snapshot them).
  const { normal, optimal, ...fields } = req.body;
  row.set(fields);
  if (normal !== undefined) row.set("normal", normal ?? undefined);
  if (optimal !== undefined) row.set("optimal", optimal ?? undefined);
  await row.save();
  await audit(req, "updated", "Biomarker", String(row._id));
  return present(row.toObject());
}
export async function listTemplates(req: Request) {
  const organizationId = actor(req).organizationId;
  const templates = await LabPanelTemplate.find({ organizationId }).sort({ name: 1 }).lean();
  const markers = await Biomarker.find({ organizationId, active: true })
    .select("key name shortName category unit resultType components")
    .lean();
  const byId = new Map(markers.map((m) => [String(m._id), m]));
  return templates.map((t) => ({
    ...t,
    // An archived marker drops out of the template instead of failing the form.
    biomarkers: t.biomarkerIds.map((id) => byId.get(String(id))).filter(Boolean),
  }));
}
