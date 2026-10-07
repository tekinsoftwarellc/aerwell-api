// Hand-maintained manifest for W8 clinical routes; the swagger drift test
// compares it with the mounted Express routes.
const error = { $ref: "#/components/schemas/ErrorResponse" };
const errors = {
  400: {
    description: "VALIDATION_ERROR, INVALID_DATES",
    content: { "application/json": { schema: error } },
  },
  401: { description: "Staff session required" },
  403: {
    description: "Missing LABS_SCANS / PROTOCOLS / CLINICAL_NOTES level (or MEMBER_RECORDS view)",
  },
  404: { description: "Not found in the organization or the actor's own (assigned-member) scope" },
  409: {
    description:
      "MEMBER_ARCHIVED, ALREADY_REVIEWED, REPORT_READY, VISIT_NOT_CLINICAL, VERSION_CONFLICT, PROTOCOL_NOT_ACTIVE, UPLOAD_ALREADY_ATTACHED, BIOMARKER_KEY_EXISTS",
  },
  422: { description: "RESULT_TYPE_MISMATCH, UPLOAD_INCOMPLETE, UPLOAD_INVALID" },
  503: {
    description:
      "STORAGE_UNAVAILABLE, UPSTREAM_UNAVAILABLE (wearables; upstream text never forwarded)",
  },
};
type Spec = [method: string, path: string, summary: string];
const listOps = (path: string, label: string, module: string): Spec[] => [
  [
    "get",
    `/members/{id}${path}`,
    `${label} {items, version, updatedAt} (${module} view). Audited.`,
  ],
  [
    "put",
    `/members/{id}${path}`,
    `Replace ${label} with {expectedVersion, items}; stale version is 409 VERSION_CONFLICT (${module} edit). Audited.`,
  ],
];
const ops: Spec[] = [
  [
    "get",
    "/biomarkers",
    "Biomarker catalog with normal/optimal ranges and labels (LABS_SCANS view). category, q, includeInactive.",
  ],
  ["post", "/biomarkers", "Add a catalog marker (LABS_SCANS master). Audited."],
  [
    "patch",
    "/biomarkers/{biomarkerId}",
    "Edit ranges/labels; key and resultType are immutable; past results keep their snapshot (LABS_SCANS master). Audited.",
  ],
  [
    "get",
    "/lab-panel-templates",
    "Full Panel, Male/Female Hormone Panel with their markers (LABS_SCANS view).",
  ],
  [
    "get",
    "/members/{id}/health-summary",
    "Clinician-entered score (source undefined), actual age, latest panel and DEXA summaries (LABS_SCANS view). Audited.",
  ],
  [
    "get",
    "/members/{id}/scores",
    "Score snapshots for range=3m|6m|1y, clinician-entered (LABS_SCANS view). Audited.",
  ],
  [
    "post",
    "/members/{id}/scores",
    "Record a clinician-entered score snapshot; nothing is computed (LABS_SCANS edit). Audited.",
  ],
  [
    "get",
    "/members/{id}/wearables/summary",
    "Read-through wearables week: status unconfigured|unlinked|ok; nothing stored; 503 UPSTREAM_UNAVAILABLE (LABS_SCANS view). Audited.",
  ],
  [
    "get",
    "/members/{id}/wearables/history",
    "Read-through wearables history (90-day default window), same contract as summary. Audited.",
  ],
  ...listOps("/goals", "Goals", "CLINICAL_NOTES"),
  ...listOps("/medical-history", "Medical history", "CLINICAL_NOTES"),
  ...listOps("/allergies", "Allergies", "CLINICAL_NOTES"),
  ...listOps("/medications", "Medications", "PROTOCOLS"),
  ...listOps("/supplements", "Supplements", "PROTOCOLS"),
  [
    "get",
    "/members/{id}/lab-panels",
    "Panels newest first with counts and notableChange (LABS_SCANS view). Audited.",
  ],
  [
    "post",
    "/members/{id}/lab-panels",
    "Manual entry and/or verified PDF (clinical_document upload); status computed from the catalog, never accepted (LABS_SCANS edit). Audited.",
  ],
  [
    "get",
    "/members/{id}/lab-panels/{panelId}",
    "Panel with results, previous values from the previous panel, key markers; category and q filter results (LABS_SCANS view). Audited.",
  ],
  [
    "post",
    "/members/{id}/lab-panels/{panelId}/review",
    "new -> reviewed once, optional findings; repeat is 409 ALREADY_REVIEWED (LABS_SCANS edit). Audited.",
  ],
  [
    "put",
    "/members/{id}/lab-panels/{panelId}/visit",
    "Link the panel to one of the member's visits (its id is the Alfred bookingRef); a ready report cannot move, 409 REPORT_READY. Sends clinical.report_ready when this makes the report ready (LABS_SCANS edit). Audited.",
  ],
  [
    "get",
    "/members/{id}/lab-panels/{panelId}/document",
    "Presigned (300 s) download of the attached report (LABS_SCANS view). Audited.",
  ],
  [
    "get",
    "/members/{id}/biomarkers/{biomarkerId}/trend",
    "Last limit (max 5) values with ranges (LABS_SCANS view). Audited.",
  ],
  [
    "get",
    "/members/{id}/scans",
    "DEXA scans newest first with metric deltas (LABS_SCANS view). Audited.",
  ],
  [
    "post",
    "/members/{id}/scans",
    "Manual DEXA entry and/or verified PDF; metric status from the catalog (LABS_SCANS edit). Audited.",
  ],
  [
    "get",
    "/members/{id}/scans/metrics/{metric}/trend",
    "Last limit (max 5) values of one DEXA metric (LABS_SCANS view). Audited.",
  ],
  [
    "get",
    "/members/{id}/scans/{scanId}",
    "Scan with metrics, regions, bone density and findings (LABS_SCANS view). Audited.",
  ],
  [
    "post",
    "/members/{id}/scans/{scanId}/review",
    "new -> reviewed once, optional findings (LABS_SCANS edit). Audited.",
  ],
  [
    "put",
    "/members/{id}/scans/{scanId}/visit",
    "Link the scan to one of the member's visits (its id is the Alfred bookingRef); a ready report cannot move, 409 REPORT_READY (LABS_SCANS edit). Audited.",
  ],
  [
    "get",
    "/members/{id}/scans/{scanId}/document",
    "Presigned (300 s) download of the attached report (LABS_SCANS view). Audited.",
  ],
  [
    "get",
    "/members/{id}/protocols",
    "Protocols by status=active|completed|discontinued|all with calendar progress (PROTOCOLS view). Audited.",
  ],
  ["post", "/members/{id}/protocols", "Create a protocol (PROTOCOLS edit). Audited."],
  ["get", "/members/{id}/protocols/{protocolId}", "One protocol (PROTOCOLS view). Audited."],
  [
    "patch",
    "/members/{id}/protocols/{protocolId}",
    "Adjust with expectedVersion; writes a revision in the same transaction when something changed (PROTOCOLS edit). Audited.",
  ],
  [
    "post",
    "/members/{id}/protocols/{protocolId}/discontinue",
    "Discontinue an active protocol; reason required; revision written (PROTOCOLS edit). Audited.",
  ],
  [
    "post",
    "/members/{id}/protocols/{protocolId}/complete",
    "Complete an active protocol; revision written (PROTOCOLS edit). Audited.",
  ],
  [
    "get",
    "/members/{id}/protocols/{protocolId}/revisions",
    "Revision history newest first (PROTOCOLS view). Audited.",
  ],
  [
    "post",
    "/members/{id}/protocols/{protocolId}/injections",
    "Log an injection for one compound (PROTOCOLS edit). Audited.",
  ],
];
const params = (path: string) =>
  [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
    name: match[1],
    in: "path",
    required: true,
    schema:
      match[1] === "metric"
        ? {
            type: "string",
            enum: ["bodyFatPct", "leanMassLb", "vatCm2", "hipTScore", "androidGynoidRatio"],
          }
        : { type: "string", pattern: "^[a-f0-9]{24}$" },
  }));
export const clinicalPaths: Record<string, Record<string, unknown>> = {};
for (const [method, path, summary] of ops) {
  const key = `/api/v1${path}`;
  clinicalPaths[key] = {
    ...clinicalPaths[key],
    [method]: {
      summary,
      tags: ["Members clinical"],
      security: [{ staffBearer: [] }],
      parameters: params(path),
      responses: {
        200: { description: "Success envelope" },
        201: { description: "Created" },
        ...errors,
      },
    },
  };
}
