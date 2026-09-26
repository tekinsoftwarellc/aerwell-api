import { type InferSchemaType, Schema, model } from "mongoose";

// Member clinical records (PHI). Every read and write is audited by the services.
const ownership = {
  organizationId: { type: String, required: true },
  memberId: { type: Schema.Types.ObjectId, ref: "Member", required: true },
};
const finding = new Schema(
  {
    severity: { type: String, enum: ["attention", "info"], required: true },
    text: { type: String, required: true },
    generatedBy: { type: String, enum: ["staff", "alfred"], default: "staff" },
    authorId: Schema.Types.ObjectId,
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);
const review = {
  reviewStatus: { type: String, enum: ["new", "reviewed"], default: "new" },
  reviewedById: Schema.Types.ObjectId,
  reviewedAt: Date,
  documentUploadId: Schema.Types.ObjectId,
  source: { type: String, enum: ["manual", "pdf", "vendor_feed"], default: "manual" },
  isBaseline: { type: Boolean, default: false },
  findings: { type: [finding], default: [] },
  createdById: Schema.Types.ObjectId,
};

// LabResult: embedded per panel. `reference` snapshots the catalog ranges
// resolved for the member's sex at entry; status/withinOptimal derive from it.
const labResult = new Schema(
  {
    biomarkerId: { type: Schema.Types.ObjectId, ref: "Biomarker", required: true },
    key: { type: String, required: true },
    name: { type: String, required: true },
    shortName: String,
    category: { type: String, required: true },
    unit: { type: String, default: null },
    resultType: { type: String, required: true },
    value: { type: Schema.Types.Mixed, default: null },
    reference: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ["normal", "high", "low", "abnormal", null], default: null },
    withinOptimal: { type: Boolean, default: null },
    isKey: { type: Boolean, default: false },
  },
  { _id: false, minimize: false }
);
const panelSchema = new Schema(
  {
    ...ownership,
    drawnAt: { type: Date, required: true },
    templateId: Schema.Types.ObjectId,
    panelType: String,
    orderedById: { type: Schema.Types.ObjectId, ref: "StaffMember" },
    orderingProviderName: String,
    vendor: String,
    fasting: Boolean,
    fastingHours: Number,
    drawType: String,
    drawLocation: String,
    nextPanelDue: String,
    results: { type: [labResult], default: [] },
    ...review,
  },
  // minimize:false keeps an empty range snapshot ({}) instead of dropping the key.
  { timestamps: true, minimize: false }
);
panelSchema.index({ organizationId: 1, memberId: 1, drawnAt: -1 });
// W11: the dashboard's "new results" review queue (count + newest first).
panelSchema.index({ organizationId: 1, reviewStatus: 1, createdAt: -1, _id: -1 });
export type LabPanelData = InferSchemaType<typeof panelSchema>;
export const LabPanel = model("LabPanel", panelSchema);

export const SCAN_METRICS = [
  "bodyFatPct",
  "leanMassLb",
  "vatCm2",
  "hipTScore",
  "androidGynoidRatio",
] as const;
export const DEXA_REGIONS = [
  "left_arm",
  "right_arm",
  "left_leg",
  "right_leg",
  "trunk",
  "android",
  "gynoid",
  "total",
] as const;
export const BONE_SITES = [
  "lumbar_spine_l1_l4",
  "femoral_neck_left",
  "total_hip_left",
  "total_body",
] as const;
const scanSchema = new Schema(
  {
    ...ownership,
    type: { type: String, enum: ["dexa"], default: "dexa" },
    performedAt: { type: Date, required: true },
    machine: String,
    technologist: String,
    facility: String,
    radiationDoseMsv: Number,
    // { [metric]: { value, unit, reference, status, withinOptimal } } (SCAN_METRICS)
    metrics: { type: Schema.Types.Mixed, default: {} },
    regions: {
      type: [
        new Schema(
          {
            region: { type: String, enum: DEXA_REGIONS, required: true },
            fatMassLb: Number,
            leanMassLb: Number,
            fatPct: Number,
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    boneDensity: {
      type: [
        new Schema(
          {
            site: { type: String, enum: BONE_SITES, required: true },
            bmdGcm2: Number,
            tScore: Number,
            zScore: Number,
            // Transcribed from the facility report; never derived here.
            classification: { type: String, enum: ["normal", "osteopenia", "osteoporosis"] },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    ...review,
  },
  { timestamps: true, minimize: false }
);
scanSchema.index({ organizationId: 1, memberId: 1, type: 1, performedAt: -1 });
scanSchema.index({ organizationId: 1, reviewStatus: 1, createdAt: -1, _id: -1 });
export type ScanData = InferSchemaType<typeof scanSchema>;
export const Scan = model("Scan", scanSchema);

// Clinician-entered scores. The source/formula of the health score and
// biological age is undefined (open question), so nothing here computes them.
const snapshotSchema = new Schema(
  {
    ...ownership,
    period: { type: String, required: true },
    overallScore: { type: Number, min: 0, max: 100 },
    statusLabel: String,
    biologicalAge: { type: Number, min: 0, max: 150 },
    bodyCompScore: { type: Number, min: 0, max: 100 },
    domainScores: {
      type: [
        new Schema(
          {
            domain: {
              type: String,
              enum: [
                "metabolic",
                "cognitive",
                "cardiovascular",
                "physical_performance",
                "sleep_recovery",
                "biomarkers",
              ],
              required: true,
            },
            score: { type: Number, min: 0, max: 100, required: true },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    source: { type: String, enum: ["clinician_entered"], default: "clinician_entered" },
    enteredById: Schema.Types.ObjectId,
  },
  { timestamps: true }
);
snapshotSchema.index({ organizationId: 1, memberId: 1, period: -1, createdAt: -1 });
export const HealthScoreSnapshot = model("HealthScoreSnapshot", snapshotSchema);

// Goals, medical history, allergies, medications and supplements: one versioned
// list per member and kind (the Figma "Edit" cards replace the whole list).
export const LIST_KINDS = [
  "goals",
  "medical_history",
  "allergies",
  "medications",
  "supplements",
] as const;
const listSchema = new Schema(
  {
    ...ownership,
    kind: { type: String, enum: LIST_KINDS, required: true },
    items: { type: [Schema.Types.Mixed], default: [] },
    version: { type: Number, default: 0 },
    updatedById: Schema.Types.ObjectId,
  },
  { timestamps: true, versionKey: false }
);
listSchema.index({ organizationId: 1, memberId: 1, kind: 1 }, { unique: true });
export const ClinicalList = model("ClinicalList", listSchema);
