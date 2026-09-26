import { type InferSchemaType, Schema, model } from "mongoose";

// Clinic-editable biomarker catalog (org-scoped). Ranges are stored as data;
// results snapshot the resolved ranges at entry so later catalog edits never
// rewrite a past result's status.
export const BIOMARKER_CATEGORIES = [
  "lipids",
  "thyroid",
  "hormones",
  "hematology",
  "liver",
  "kidney",
  "micronutrients",
  "metals",
  "genetic",
  "body_composition",
] as const;
export const RESULT_TYPES = ["numeric", "categorical", "genotype", "compound"] as const;

const range = new Schema(
  {
    min: Number,
    max: Number,
    minExclusive: Boolean,
    maxExclusive: Boolean,
    values: { type: [String], default: undefined },
    any: Boolean,
    label: String,
  },
  { _id: false }
);
const bounds = new Schema({ normal: range, optimal: range }, { _id: false });
const component = new Schema(
  { label: { type: String, required: true }, unit: String, normal: range, optimal: range },
  { _id: false }
);
const biomarkerSchema = new Schema(
  {
    organizationId: { type: String, required: true },
    key: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    shortName: { type: String, trim: true },
    category: { type: String, enum: BIOMARKER_CATEGORIES, required: true },
    unit: { type: String, default: null },
    resultType: { type: String, enum: RESULT_TYPES, required: true },
    normal: range,
    optimal: range,
    sexRanges: { male: bounds, female: bounds },
    components: { type: [component], default: undefined },
    oneTime: { type: Boolean, default: false },
    calculated: { type: Boolean, default: false },
    isKey: { type: Boolean, default: false },
    sortOrder: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);
biomarkerSchema.index({ organizationId: 1, key: 1 }, { unique: true });
biomarkerSchema.index({ organizationId: 1, category: 1, sortOrder: 1 });
export type BiomarkerData = InferSchemaType<typeof biomarkerSchema>;
export const Biomarker = model("Biomarker", biomarkerSchema);

const templateSchema = new Schema(
  {
    organizationId: { type: String, required: true },
    key: { type: String, required: true },
    name: { type: String, required: true },
    biomarkerIds: [{ type: Schema.Types.ObjectId, ref: "Biomarker" }],
  },
  { timestamps: true }
);
templateSchema.index({ organizationId: 1, key: 1 }, { unique: true });
export const LabPanelTemplate = model("LabPanelTemplate", templateSchema);
