import { z } from "zod";
import { idParams, nonEmptyPatch, objectId } from "../../common/http.js";
import { dateOnly } from "../staff/staff.schema.js";
import { BIOMARKER_CATEGORIES, RESULT_TYPES } from "./catalog.model.js";
import { DOSE_UNITS, FREQUENCY_PERIODS, ROUTES } from "./protocol.model.js";
import { BONE_SITES, DEXA_REGIONS, SCAN_METRICS } from "./records.model.js";

const text = (max = 200) => z.string().trim().min(1).max(max);
const optionalText = (max = 200) => z.string().trim().max(max).optional();
const instant = z.string().datetime({ offset: true });
const finite = z.number().finite();

// ---- Catalog
const range = z
  .object({
    min: finite.optional(),
    max: finite.optional(),
    minExclusive: z.boolean().optional(),
    maxExclusive: z.boolean().optional(),
    values: z.array(text(80)).max(20).optional(),
    any: z.boolean().optional(),
    label: optionalText(80),
  })
  .strict()
  .refine((r) => r.min === undefined || r.max === undefined || r.min <= r.max, {
    message: "min must not exceed max",
    path: ["min"],
  });
const bounds = z.object({ normal: range.optional(), optimal: range.optional() }).strict();
const biomarkerFields = {
  name: text(),
  shortName: optionalText(80),
  category: z.enum(BIOMARKER_CATEGORIES),
  unit: z.string().trim().max(40).nullable().optional(),
  normal: range.nullable().optional(),
  optimal: range.nullable().optional(),
  sexRanges: z.object({ male: bounds.optional(), female: bounds.optional() }).strict().optional(),
  components: z
    .array(
      z
        .object({
          label: text(40),
          unit: z.string().trim().max(40).nullable().optional(),
          normal: range.optional(),
          optimal: range.optional(),
        })
        .strict()
    )
    .max(6)
    .optional(),
  oneTime: z.boolean().optional(),
  calculated: z.boolean().optional(),
  isKey: z.boolean().optional(),
  active: z.boolean().optional(),
};
export const biomarkerCreate = z
  .object({
    key: z.string().regex(/^[a-z0-9_]{2,60}$/, "Use lowercase letters, digits and _"),
    resultType: z.enum(RESULT_TYPES),
    ...biomarkerFields,
  })
  .strict();
export const biomarkerPatch = nonEmptyPatch(z.object(biomarkerFields).partial().strict());
export const biomarkerParams = z.object({ biomarkerId: objectId }).strict();
export const biomarkerQuery = z
  .object({
    category: z.enum(BIOMARKER_CATEGORIES).optional(),
    q: z.string().trim().max(80).optional(),
    includeInactive: z.enum(["true", "false"]).optional(),
  })
  .strict();

// ---- Lab panels
const findingInput = z
  .object({ severity: z.enum(["attention", "info"]), text: text(500) })
  .strict();
const resultInput = z
  .object({
    biomarkerId: objectId,
    value: z
      .union([finite, z.string().trim().min(1).max(80), z.array(finite).min(1).max(6)])
      .nullable(),
  })
  .strict();
export const panelCreate = z
  .object({
    drawnAt: instant,
    templateId: objectId.optional(),
    panelType: optionalText(80),
    orderedById: objectId.optional(),
    orderingProviderName: optionalText(),
    vendor: optionalText(),
    fasting: z.boolean().optional(),
    fastingHours: z.number().int().min(0).max(72).optional(),
    drawType: optionalText(80),
    drawLocation: optionalText(),
    nextPanelDue: dateOnly.optional(),
    isBaseline: z.boolean().optional(),
    results: z.array(resultInput).max(120).default([]),
    findings: z.array(findingInput).max(20).default([]),
    documentUploadId: objectId.optional(),
  })
  .strict()
  .refine((v) => v.results.length > 0 || v.documentUploadId, {
    message: "Enter at least one result or attach the report",
    path: ["results"],
  })
  .refine((v) => new Set(v.results.map((r) => r.biomarkerId)).size === v.results.length, {
    message: "Each biomarker may appear once per panel",
    path: ["results"],
  });
export const panelParams = idParams.extend({ panelId: objectId }).strict();
export const panelQuery = z
  .object({
    category: z.enum(BIOMARKER_CATEGORIES).optional(),
    q: z.string().trim().max(80).optional(),
  })
  .strict();
export const reviewBody = z.object({ findings: z.array(findingInput).max(20).optional() }).strict();
export const trendParams = idParams.extend({ biomarkerId: objectId }).strict();
export const trendQuery = z
  .object({ limit: z.coerce.number().int().min(1).max(5).default(5) })
  .strict();

// ---- Scans
const metricValue = z.number().finite().nullable().optional();
export const scanCreate = z
  .object({
    type: z.literal("dexa").default("dexa"),
    performedAt: instant,
    machine: optionalText(),
    technologist: optionalText(),
    facility: optionalText(),
    radiationDoseMsv: z.number().min(0).max(100).optional(),
    metrics: z
      .object(Object.fromEntries(SCAN_METRICS.map((m) => [m, metricValue])))
      .strict()
      .default({}),
    regions: z
      .array(
        z
          .object({
            region: z.enum(DEXA_REGIONS),
            fatMassLb: z.number().min(0).optional(),
            leanMassLb: z.number().min(0).optional(),
            fatPct: z.number().min(0).max(100).optional(),
          })
          .strict()
      )
      .max(DEXA_REGIONS.length)
      .default([]),
    boneDensity: z
      .array(
        z
          .object({
            site: z.enum(BONE_SITES),
            bmdGcm2: z.number().min(0).optional(),
            tScore: finite.optional(),
            zScore: finite.optional(),
            classification: z.enum(["normal", "osteopenia", "osteoporosis"]).optional(),
          })
          .strict()
      )
      .max(BONE_SITES.length)
      .default([]),
    isBaseline: z.boolean().optional(),
    findings: z.array(findingInput).max(20).default([]),
    documentUploadId: objectId.optional(),
  })
  .strict();
export const scanParams = idParams.extend({ scanId: objectId }).strict();
export const scanQuery = z.object({ type: z.literal("dexa").optional() }).strict();
export const scanTrendParams = idParams.extend({ metric: z.enum(SCAN_METRICS) }).strict();

// ---- Scores
export const scoreCreate = z
  .object({
    period: dateOnly,
    overallScore: z.number().int().min(0).max(100).optional(),
    statusLabel: optionalText(60),
    biologicalAge: z.number().min(0).max(150).optional(),
    bodyCompScore: z.number().int().min(0).max(100).optional(),
    domainScores: z
      .array(
        z
          .object({
            domain: z.enum([
              "metabolic",
              "cognitive",
              "cardiovascular",
              "physical_performance",
              "sleep_recovery",
              "biomarkers",
            ]),
            score: z.number().int().min(0).max(100),
          })
          .strict()
      )
      .max(6)
      .refine((d) => new Set(d.map((x) => x.domain)).size === d.length, "Each domain once")
      .default([]),
  })
  .strict()
  .refine(
    (v) =>
      [v.overallScore, v.biologicalAge, v.bodyCompScore].some((x) => x !== undefined) ||
      v.domainScores.length > 0,
    { message: "Enter at least one score or age", path: ["overallScore"] }
  );
export const scoreQuery = z.object({ range: z.enum(["3m", "6m", "1y"]).default("6m") }).strict();

// ---- Wearables (read-only proxy seam)
export const wearableQuery = z
  .object({
    metric: z.enum(["sleep", "activity"]),
    from: dateOnly.optional(),
    to: dateOnly.optional(),
  })
  .strict();

// ---- Versioned lists
const listBody = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ expectedVersion: z.number().int().min(0), items: z.array(item).max(50) }).strict();
const dosed = z
  .object({
    name: text(120),
    dose: optionalText(80),
    frequency: optionalText(80),
    directions: optionalText(300),
    since: dateOnly.optional(),
  })
  .strict();
export const LIST_BODIES = {
  goals: listBody(z.object({ title: text(120) }).strict()),
  medical_history: listBody(
    z.object({ relation: optionalText(60), condition: text(160) }).strict()
  ),
  allergies: listBody(z.object({ name: text(120), reaction: optionalText(160) }).strict()),
  medications: listBody(dosed),
  supplements: listBody(dosed),
};

// ---- Protocols
const itemInput = z
  .object({
    compound: text(80),
    doseAmount: z.number().positive().max(100000),
    doseUnit: z.enum(DOSE_UNITS),
    frequencyCount: z.number().int().min(1).max(31),
    frequencyPeriod: z.enum(FREQUENCY_PERIODS),
    route: z.enum(ROUTES),
  })
  .strict();
const protocolFields = {
  prescribingProviderId: objectId,
  startDate: dateOnly,
  estEndDate: dateOnly,
  supplyRemainingDays: z.number().int().min(0).max(3650).optional(),
  nextRefillDue: dateOnly.optional(),
  lastInjectionSite: optionalText(80),
};
const datesInOrder = (v: { startDate?: string; estEndDate?: string }) =>
  !(v.startDate && v.estEndDate) || v.startDate <= v.estEndDate;
export const protocolCreate = z
  .object({
    type: text(80),
    name: text(160),
    description: optionalText(2000),
    items: z.array(itemInput).min(1).max(10),
    ...protocolFields,
  })
  .strict()
  .refine(datesInOrder, { message: "End date must not precede start", path: ["estEndDate"] });
export const protocolPatch = z
  .object({
    ...protocolFields,
    description: optionalText(2000),
    items: z
      .array(itemInput.extend({ _id: objectId.optional() }).strict())
      .min(1)
      .max(10),
    expectedVersion: z.number().int().min(0),
    reason: optionalText(300),
  })
  .partial()
  .required({ expectedVersion: true })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== "expectedVersion" && k !== "reason"), {
    message: "Provide at least one field",
    path: ["expectedVersion"],
  })
  .refine(datesInOrder, { message: "End date must not precede start", path: ["estEndDate"] });
export const protocolParams = idParams.extend({ protocolId: objectId }).strict();
export const protocolQuery = z
  .object({ status: z.enum(["active", "completed", "discontinued", "all"]).default("all") })
  .strict();
export const discontinueBody = z.object({ reason: text(300) }).strict();
export const injectionBody = z
  .object({ itemId: objectId, administeredAt: instant, site: text(80) })
  .strict();
