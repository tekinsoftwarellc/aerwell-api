import type { Request } from "express";
import { ConflictError, NotFoundError } from "../../common/errors/AppError.js";
import { audit } from "../audit/audit.js";
import type { MemberDocument } from "../member/member.model.js";
import { Biomarker } from "./catalog.model.js";
import {
  actorId,
  auditRead,
  auditedWrite,
  byMember,
  claimDocument,
  clinicalMember,
  documentLink,
  verifyDocument,
} from "./clinical.shared.js";
import { deltaPct } from "./labs.service.js";
import { computeStatus, referenceLabels, resolveReference } from "./range.js";
import { SCAN_METRICS, Scan } from "./records.model.js";

type Metric = (typeof SCAN_METRICS)[number];
// Scan metrics read their ranges from the same editable catalog as labs.
export const METRIC_KEYS: Record<Metric, string> = {
  bodyFatPct: "dexa_body_fat_pct",
  leanMassLb: "dexa_lean_mass_lb",
  vatCm2: "dexa_vat_cm2",
  hipTScore: "dexa_hip_t_score",
  androidGynoidRatio: "dexa_android_gynoid_ratio",
};
async function buildMetrics(member: MemberDocument, input: Partial<Record<Metric, number | null>>) {
  const markers = await Biomarker.find({
    organizationId: member.organizationId,
    key: { $in: Object.values(METRIC_KEYS) },
  }).lean();
  const byKey = new Map(markers.map((m) => [m.key, m]));
  const metrics: Record<string, unknown> = {};
  for (const metric of SCAN_METRICS) {
    const value = input[metric];
    if (value === undefined || value === null) continue;
    const marker = byKey.get(METRIC_KEYS[metric]);
    const reference = marker ? resolveReference(marker, member.sex) : {};
    metrics[metric] = {
      value,
      unit: marker?.unit ?? null,
      reference,
      ...computeStatus({ resultType: "numeric", reference }, value),
    };
  }
  return metrics;
}
type MetricRow = { value: number; status: string | null } & Record<string, unknown>;
const metricsOf = (scan: { metrics?: unknown }) =>
  (scan.metrics ?? {}) as Record<string, MetricRow>;
function overallStatus(scan: { metrics?: unknown }) {
  const statuses = Object.values(metricsOf(scan))
    .map((m) => m.status)
    .filter(Boolean);
  if (!statuses.length) return null;
  return statuses.every((s) => s === "normal") ? "all_normal" : "attention";
}

export async function createScan(req: Request) {
  const member = await clinicalMember(req, "LABS_SCANS", true);
  const { metrics, findings, documentUploadId, ...fields } = req.body;
  const built = await buildMetrics(member, metrics);
  const upload = await verifyDocument(req, documentUploadId);
  return auditedWrite(req, member, { action: "created", targetType: "Scan" }, async (session) => {
    const [row] = await Scan.create(
      [
        {
          ...fields,
          ...byMember(member),
          metrics: built,
          findings: findings.map((f: object) => ({ ...f, authorId: actorId(req) })),
          source: Object.keys(built).length ? "manual" : upload ? "pdf" : "manual",
          documentUploadId: upload?._id,
          createdById: actorId(req),
        },
      ],
      { session }
    );
    if (!row) throw new Error("Scan was not created");
    if (upload) await claimDocument(upload._id, `Scan:${row._id}`, session);
    return row;
  });
}

const delta = (a: MetricRow | undefined, b: MetricRow | undefined) =>
  a && b ? Math.round((a.value - b.value) * 100) / 100 : null;
function withDeltas(scan: { metrics?: unknown }, previous?: { metrics?: unknown }) {
  const now = metricsOf(scan);
  const before = previous ? metricsOf(previous) : {};
  return {
    metrics: Object.fromEntries(
      Object.entries(now).map(([k, m]) => [
        k,
        {
          ...m,
          ...referenceLabels((m["reference"] ?? {}) as object),
          delta: delta(m, before[k]),
          deltaPct: deltaPct(m.value, before[k]?.value),
        },
      ])
    ),
    overallStatus: overallStatus(scan),
  };
}
export async function listScans(req: Request) {
  const member = await clinicalMember(req, "LABS_SCANS");
  const rows = await Scan.find({
    ...byMember(member),
    ...(req.query["type"] ? { type: req.query["type"] } : {}),
  })
    .select("-regions -boneDensity -findings")
    .sort({ performedAt: -1, _id: -1 })
    .limit(100)
    .lean();
  await auditRead(req, "Scans", member);
  return rows.map(({ documentUploadId, ...row }, i) => ({
    ...row,
    ...withDeltas(row, rows[i + 1]),
    hasDocument: Boolean(documentUploadId),
  }));
}
async function scanOf(member: MemberDocument, scanId: unknown) {
  const scan = await Scan.findOne({ ...byMember(member), _id: scanId }).lean();
  if (!scan) throw new NotFoundError("Scan not found");
  return scan;
}
export async function getScan(req: Request) {
  const member = await clinicalMember(req, "LABS_SCANS");
  const scan = await scanOf(member, req.params["scanId"]);
  const previous = await Scan.findOne({
    ...byMember(member),
    type: scan.type,
    performedAt: { $lt: scan.performedAt },
  })
    .sort({ performedAt: -1, _id: -1 })
    .lean();
  await auditRead(req, "Scan", member, String(scan._id));
  const { documentUploadId, ...rest } = scan;
  return {
    ...rest,
    ...withDeltas(scan, previous ?? undefined),
    hasDocument: Boolean(documentUploadId),
    previousScan: previous ? { _id: previous._id, performedAt: previous.performedAt } : null,
  };
}
export async function reviewScan(req: Request) {
  const member = await clinicalMember(req, "LABS_SCANS", true);
  const filter = { ...byMember(member), _id: req.params["scanId"] };
  const findings = (req.body.findings ?? []).map((f: object) => ({ ...f, authorId: actorId(req) }));
  return auditedWrite(req, member, { action: "reviewed", targetType: "Scan" }, async (session) => {
    const row = await Scan.findOneAndUpdate(
      { ...filter, reviewStatus: "new" },
      {
        $set: { reviewStatus: "reviewed", reviewedById: actorId(req), reviewedAt: new Date() },
        $push: { findings: { $each: findings } },
      },
      { new: true, session }
    );
    if (row) return row;
    if (await Scan.exists(filter).session(session))
      throw new ConflictError("Scan is already reviewed", undefined, "ALREADY_REVIEWED");
    throw new NotFoundError("Scan not found");
  });
}
export async function scanDocument(req: Request) {
  const member = await clinicalMember(req, "LABS_SCANS");
  return documentLink(req, member, await scanOf(member, req.params["scanId"]), "Scan");
}
export async function scanTrend(req: Request) {
  const member = await clinicalMember(req, "LABS_SCANS");
  const metric = String(req.params["metric"]);
  const path = `metrics.${metric}.value`;
  const rows = await Scan.find({ ...byMember(member), [path]: { $type: "number" } })
    .sort({ performedAt: -1, _id: -1 })
    .limit(Number(req.query["limit"] ?? 5))
    .lean();
  const points = rows.reverse().map((s) => {
    const m = metricsOf(s)[metric] as MetricRow;
    return { scanId: s._id, performedAt: s.performedAt, value: m.value, status: m.status };
  });
  const reference = (metricsOf(rows.at(-1) ?? {})[metric]?.["reference"] ?? {}) as object;
  await audit(req, "viewed", "ScanTrend", metric, String(member._id));
  return { metric, reference, ...referenceLabels(reference), points };
}
