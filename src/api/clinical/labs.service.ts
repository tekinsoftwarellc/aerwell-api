import type { Request } from "express";
import { ConflictError, NotFoundError, ValidationError } from "../../common/errors/AppError.js";
import { escapedSearch } from "../../common/http.js";
import { audit } from "../audit/audit.js";
import type { MemberDocument } from "../member/member.model.js";
import { clinicalReview } from "../notification/producers.js";
import { Biomarker, type BiomarkerData, LabPanelTemplate } from "./catalog.model.js";
import {
  actorId,
  assertStaff,
  auditRead,
  auditedWrite,
  byMember,
  claimDocument,
  clinicalMember,
  documentLink,
  staffNames,
  verifyDocument,
  withoutDocument,
} from "./clinical.shared.js";
import {
  OUT_OF_RANGE,
  type Reference,
  type ResultValue,
  type Status,
  computeStatus,
  referenceLabels,
  resolveReference,
} from "./range.js";
import { LabPanel } from "./records.model.js";
import { assertVisit, enqueueReportReady } from "./reportLink.js";

type Marker = BiomarkerData & { _id: unknown };
interface StoredResult {
  biomarkerId: unknown;
  key: string;
  name: string;
  shortName?: string | null;
  category: string;
  unit?: string | null;
  resultType: string;
  value?: ResultValue;
  reference?: Reference;
  status?: Status | string | null;
  withinOptimal?: boolean | null;
  isKey?: boolean | null;
}

function valueFits(marker: Marker, value: ResultValue) {
  if (value === null) return true;
  if (marker.resultType === "numeric") return typeof value === "number";
  if (marker.resultType === "compound")
    return Array.isArray(value) && value.length === (marker.components?.length ?? 0);
  return typeof value === "string";
}
/** Snapshot the member's catalog ranges and derive status; input status is never accepted. */
export function buildResult(marker: Marker, value: ResultValue, sex?: string | null) {
  if (!valueFits(marker, value))
    throw new ValidationError(
      `Result for ${marker.key} must match its ${marker.resultType} result type`,
      "RESULT_TYPE_MISMATCH"
    );
  const resultType = marker.resultType as "numeric" | "categorical" | "genotype" | "compound";
  const reference = resolveReference(marker as Parameters<typeof resolveReference>[0], sex);
  return {
    biomarkerId: marker._id,
    key: marker.key,
    name: marker.name,
    shortName: marker.shortName,
    category: marker.category,
    unit: marker.unit ?? null,
    resultType,
    value,
    reference,
    ...computeStatus({ resultType, reference }, value),
    isKey: marker.isKey ?? false,
  };
}
export async function markersFor(organizationId: string, ids: string[]) {
  const markers = await Biomarker.find({ organizationId, _id: { $in: ids }, active: true }).lean();
  if (markers.length !== new Set(ids).size) throw new NotFoundError("Biomarker not found");
  return new Map(markers.map((m) => [String(m._id), m as Marker]));
}

const tested = (r: StoredResult) => r.value !== null && r.value !== undefined;
const flagged = (r: StoredResult) => OUT_OF_RANGE.has((r.status ?? null) as Status);
export const panelCounts = (results: StoredResult[]) => ({
  markersOrdered: results.length,
  markersTested: results.filter(tested).length,
  outOfRangeCount: results.filter(flagged).length,
});
export function deltaPct(value: unknown, previous: unknown) {
  if (typeof value !== "number" || typeof previous !== "number" || previous === 0) return null;
  return Math.round(((value - previous) / Math.abs(previous)) * 1000) / 10;
}
function present(result: StoredResult, previous?: StoredResult) {
  return {
    ...result,
    ...referenceLabels(result.reference ?? {}),
    previousValue: previous?.value ?? null,
    deltaPct: deltaPct(result.value, previous?.value),
  };
}

async function createPanelRow(req: Request) {
  const member = await clinicalMember(req, "LABS_SCANS", true);
  const { results, findings, documentUploadId, ...fields } = req.body;
  if (fields.orderedById) await assertStaff(member.organizationId, fields.orderedById);
  if (
    fields.templateId &&
    !(await LabPanelTemplate.exists({
      _id: fields.templateId,
      organizationId: member.organizationId,
    }))
  )
    throw new NotFoundError("Panel template not found");
  const markers = await markersFor(
    member.organizationId,
    results.map((r: { biomarkerId: string }) => r.biomarkerId)
  );
  const built = results.map((r: { biomarkerId: string; value: ResultValue }) =>
    buildResult(markers.get(r.biomarkerId) as Marker, r.value, member.sex)
  );
  if (fields.appointmentId) await assertVisit(member, fields.appointmentId);
  const upload = await verifyDocument(req, documentUploadId);
  return auditedWrite(
    req,
    member,
    { action: "created", targetType: "LabPanel" },
    async (session) => {
      const [row] = await LabPanel.create(
        [
          {
            ...fields,
            ...byMember(member),
            results: built,
            findings: findings.map((f: object) => ({ ...f, authorId: actorId(req) })),
            source: built.length ? "manual" : "pdf",
            documentUploadId: upload?._id,
            createdById: actorId(req),
          },
        ],
        { session }
      );
      if (!row) throw new Error("Lab panel was not created");
      if (upload) await claimDocument(upload._id, `LabPanel:${row._id}`, session);
      return row;
    }
  );
}

type PanelRow = {
  _id: unknown;
  drawnAt: Date;
  results: StoredResult[];
  isBaseline?: boolean | null;
};
function notableChange(panel: PanelRow, previous?: PanelRow) {
  if (panel.isBaseline) return { baseline: true };
  const before = new Map((previous?.results ?? []).map((r) => [String(r.biomarkerId), r]));
  for (const r of panel.results.filter(flagged)) {
    const change = deltaPct(r.value, before.get(String(r.biomarkerId))?.value);
    if (change !== null)
      return { name: r.shortName ?? r.name, value: r.value, unit: r.unit, deltaPct: change };
  }
  return null;
}
// ponytail: whole history in one query; paginate if a member ever passes ~100 panels.
export async function listPanels(req: Request) {
  const member = await clinicalMember(req, "LABS_SCANS");
  const rows = (await LabPanel.find(byMember(member))
    .sort({ drawnAt: -1, _id: -1 })
    .limit(100)
    .lean()) as unknown as (PanelRow & Record<string, unknown>)[];
  const names = await staffNames(rows.map((r) => r["orderedById"]));
  await auditRead(req, "LabPanels", member);
  return rows.map(({ results, findings, ...row }, i) => ({
    ...withoutDocument(row),
    orderedByName: names.get(String(row["orderedById"])) ?? null,
    ...panelCounts(results),
    notableChange: notableChange({ ...row, results }, rows[i + 1]),
  }));
}

async function panelOf(member: MemberDocument, panelId: unknown) {
  const panel = await LabPanel.findOne({ ...byMember(member), _id: panelId }).lean();
  if (!panel) throw new NotFoundError("Lab panel not found");
  return panel;
}
export async function getPanel(req: Request) {
  const member = await clinicalMember(req, "LABS_SCANS");
  const panel = await panelOf(member, req.params["panelId"]);
  const previous = await LabPanel.findOne({ ...byMember(member), drawnAt: { $lt: panel.drawnAt } })
    .sort({ drawnAt: -1, _id: -1 })
    .lean();
  const before = new Map((previous?.results ?? []).map((r) => [String(r.biomarkerId), r]));
  const all = (panel.results as StoredResult[]).map((r) =>
    present(r, before.get(String(r.biomarkerId)) as StoredResult | undefined)
  );
  const { category, q } = req.query as { category?: string; q?: string };
  const search = q ? new RegExp(escapedSearch(q), "i") : null;
  const results = all.filter(
    (r) =>
      (!category || r.category === category) &&
      (!search || search.test(r.name) || search.test(r.shortName ?? ""))
  );
  // Flagged markers lead the tiles, then the clinic's key markers.
  const keyMarkers = all
    .filter((r) => flagged(r) || r.isKey)
    .sort((a, b) => Number(flagged(b)) - Number(flagged(a)))
    .slice(0, 4);
  const names = await staffNames([panel.orderedById, panel.reviewedById]);
  await auditRead(req, "LabPanel", member, String(panel._id));
  const { documentUploadId, ...rest } = panel;
  return {
    ...rest,
    results,
    keyMarkers,
    ...panelCounts(panel.results as StoredResult[]),
    orderedByName: names.get(String(panel.orderedById)) ?? null,
    reviewedByName: names.get(String(panel.reviewedById)) ?? null,
    hasDocument: Boolean(documentUploadId),
    previousPanel: previous ? { _id: previous._id, drawnAt: previous.drawnAt } : null,
  };
}

async function reviewPanelRow(req: Request) {
  const member = await clinicalMember(req, "LABS_SCANS", true);
  const filter = { ...byMember(member), _id: req.params["panelId"] };
  const findings = (req.body.findings ?? []).map((f: object) => ({ ...f, authorId: actorId(req) }));
  return auditedWrite(
    req,
    member,
    { action: "reviewed", targetType: "LabPanel" },
    async (session) => {
      const row = await LabPanel.findOneAndUpdate(
        { ...filter, reviewStatus: "new" },
        {
          $set: { reviewStatus: "reviewed", reviewedById: actorId(req), reviewedAt: new Date() },
          $push: { findings: { $each: findings } },
        },
        { new: true, session, projection: { results: 0 } }
      );
      if (row) {
        await enqueueReportReady("lab", row, session);
        return row;
      }
      if (await LabPanel.exists(filter).session(session))
        throw new ConflictError("Panel is already reviewed", undefined, "ALREADY_REVIEWED");
      throw new NotFoundError("Lab panel not found");
    }
  );
}
export async function panelDocument(req: Request) {
  const member = await clinicalMember(req, "LABS_SCANS");
  return documentLink(req, member, await panelOf(member, req.params["panelId"]), "LabPanel");
}

export async function biomarkerTrend(req: Request) {
  const member = await clinicalMember(req, "LABS_SCANS");
  const marker = await Biomarker.findOne({
    _id: req.params["biomarkerId"],
    organizationId: member.organizationId,
  }).lean();
  if (!marker) throw new NotFoundError("Biomarker not found");
  const match = { biomarkerId: marker._id, value: { $ne: null } };
  const panels = await LabPanel.find({ ...byMember(member), results: { $elemMatch: match } })
    .sort({ drawnAt: -1, _id: -1 })
    .limit(Number(req.query["limit"] ?? 5))
    .lean();
  const points = panels.reverse().map((p) => {
    const r = p.results.find((x) => String(x.biomarkerId) === String(marker._id)) as StoredResult;
    return {
      panelId: p._id,
      drawnAt: p.drawnAt,
      value: r.value,
      status: r.status,
      withinOptimal: r.withinOptimal,
    };
  });
  const latest = panels.at(-1)?.results.find((x) => String(x.biomarkerId) === String(marker._id));
  const reference = (latest?.reference ??
    resolveReference(marker as Marker, member.sex)) as Reference;
  await audit(req, "viewed", "BiomarkerTrend", String(marker._id), String(member._id));
  return {
    biomarker: {
      _id: marker._id,
      key: marker.key,
      name: marker.name,
      shortName: marker.shortName,
      unit: marker.unit,
    },
    reference,
    ...referenceLabels(reference),
    points,
  };
}

export async function createPanel(req: Request) {
  const row = await createPanelRow(req);
  await clinicalReview("lab_review", row, actorId(req));
  return withoutDocument(row);
}
export const reviewPanel = async (req: Request) => withoutDocument(await reviewPanelRow(req));
