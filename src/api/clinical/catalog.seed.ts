import { Biomarker, LabPanelTemplate } from "./catalog.model.js";
import type { Range } from "./range.js";

// Initial catalog transcribed from Figma "02 Members" 7.0 Labs table, the
// "Group 30" Full Panel list, the "New Lab List" hormone panels and the 8.0
// DEXA screen (aerwell-spec/modules/02b-members-clinical.md). Every value is
// editable data. Markers whose ranges or units the design does not print are
// seeded WITHOUT them (status stays null) until the clinic enters them.
const lt = (max: number): Range => ({ max, maxExclusive: true });
const gt = (min: number): Range => ({ min, minExclusive: true });
const between = (min: number, max: number): Range => ({ min, max });
const oneOf = (...values: string[]): Range => ({ values });
type Seed = {
  key: string;
  name: string;
  shortName?: string;
  category: string;
  unit?: string | null;
  resultType?: "numeric" | "categorical" | "genotype" | "compound";
  normal?: Range;
  optimal?: Range;
  sexRanges?: Record<string, { normal?: Range; optimal?: Range }>;
  components?: { label: string; unit?: string | null; normal?: Range; optimal?: Range }[];
  oneTime?: boolean;
  calculated?: boolean;
  isKey?: boolean;
};
const n = (
  key: string,
  name: string,
  category: string,
  unit: string | null,
  normal?: Range,
  optimal?: Range,
  extra: Partial<Seed> = {}
): Seed => ({ key, name, category, unit, normal, optimal, ...extra });

export const BIOMARKER_SEED: Seed[] = [
  n(
    "lipid_panel_standard",
    "Lipid Panel, Standard (Total cholesterol, LDL, HDL, Triglycerides, non-HDL)",
    "lipids",
    "mg/dL",
    lt(200),
    lt(170),
    { shortName: "Lipid Panel" }
  ),
  n(
    "lipid_particle_size",
    "Boston Heart lipid particle sizes",
    "lipids",
    null,
    oneOf("Pattern A", "Pattern B"),
    oneOf("Pattern A"),
    { resultType: "categorical" }
  ),
  n("apob", "Apolipoprotein B (ApoB), ApoB/ApoA1, CardioIQ", "lipids", "mg/dL", lt(100), lt(80), {
    shortName: "ApoB",
  }),
  n("apoa1", "Apolipoprotein A1", "lipids", "mg/dL", between(110, 180), between(140, 170)),
  n("lipoprotein_a", "Lipoprotein(a)", "lipids", null, lt(75), lt(50)),
  n("oxidized_ldl", "Oxidized LDL (OxLDL)", "lipids", "U/L", lt(60), lt(45)),
  n("myeloperoxidase", "Myeloperoxidase (MPO)", "lipids", "pmol/L", lt(470), lt(400)),
  n("lp_pla2", "Lp-PLA2 Activity", "lipids", "nmol/min/mL", lt(124), lt(100)),
  n("hs_crp", "hs-CRP", "lipids", "mg/L", lt(3.0), lt(1.0)),
  n("homocysteine", "Homocysteine", "lipids", "μmol/L", between(5, 15), between(6, 9)),
  n("omegacheck", "OmegaCheck", "lipids", "%", gt(5.0), gt(8.0)),
  n("hemoglobin_a1c", "Hemoglobin A1c", "lipids", "%", lt(5.7), between(4.8, 5.2)),
  n("insulin", "Insulin", "lipids", "μIU/mL", between(2.6, 24.9), between(3, 8)),
  n(
    "homa_ir",
    "HOMA-IR (calculated from fasting insulin and glucose)",
    "lipids",
    null,
    lt(2.5),
    lt(1.5),
    { calculated: true, shortName: "HOMA-IR" }
  ),
  n("leptin", "Leptin", "lipids", "ng/mL", between(2, 11), between(3, 8)),
  n("uric_acid", "Uric Acid", "lipids", "mg/dL", between(3.4, 7.0), between(4.5, 6.0)),
  n(
    "calculated_ratios",
    "Calculated Ratios: TG/HDL, ApoB/ApoA1, Chol/HDL",
    "lipids",
    null,
    undefined,
    undefined,
    {
      resultType: "compound",
      calculated: true,
      components: [{ label: "TG/HDL" }, { label: "ApoB/ApoA1" }, { label: "Chol/HDL" }],
    }
  ),
  n("ldl_cholesterol", "LDL Cholesterol", "lipids", "mg/dL", undefined, lt(130), {
    shortName: "LDL",
    isKey: true,
  }),
  n("hdl_cholesterol", "HDL Cholesterol", "lipids", "mg/dL", undefined, undefined, {
    shortName: "HDL",
    isKey: true,
  }),
  n("glucose", "Glucose", "hematology", "mg/dL", undefined, undefined, { isKey: true }),
  n("tsh", "TSH", "thyroid", "mIU/L", between(0.4, 4.0), between(1.0, 2.5)),
  n("free_t4", "Free T4", "thyroid", "ng/dL", between(0.8, 1.8), between(1.0, 1.5)),
  n("free_t3", "Free T3", "thyroid", "pg/mL", between(2.3, 4.2), between(3.0, 4.0)),
  n("tpo_antibodies", "Thyroid Peroxidase Antibodies (TPO)", "thyroid", "IU/mL", lt(35), lt(15)),
  n("thyroglobulin_antibodies", "Thyroglobulin Antibodies", "thyroid", "IU/mL", lt(40), lt(20)),
  n("reverse_t3", "Reverse T3", "thyroid", "ng/dL", between(8, 25), between(12, 18)),
  n("igf1", "IGF-1 (LC/MS)", "hormones", "ng/mL", between(115, 307), between(150, 250)),
  n("dhea_sulfate", "DHEA Sulfate", "hormones", "μg/dL", between(70, 430), between(150, 350)),
  n("prolactin", "Prolactin", "hormones", "ng/mL", between(4.0, 15.2), between(6, 12)),
  n("cortisol_am", "Cortisol, AM", "hormones", "μg/dL", between(6.2, 19.4), between(10, 18)),
  n(
    "cmp",
    "Comprehensive Metabolic Panel (CMP) (18 different values)",
    "hematology",
    null,
    { label: "In range", values: ["Complete"] },
    { label: "Optimal" },
    { resultType: "categorical", shortName: "CMP" }
  ),
  n(
    "cbc",
    "CBC with Differential and Platelets (10 nucleated indices + 5 WBC types reported as absolute and %)",
    "hematology",
    null,
    { label: "In range", values: ["Complete"] },
    { label: "Optimal" },
    { resultType: "categorical", shortName: "CBC" }
  ),
  n(
    "iron_tibc_ferritin",
    "Iron, TIBC, and Ferritin",
    "hematology",
    "μg/dL",
    between(59, 158),
    between(80, 130)
  ),
  n(
    "nlr",
    "Calculated Ratio: Neutrophil to lymphocyte ratio (NLR)",
    "hematology",
    null,
    between(1.0, 3.0),
    between(1.0, 2.0),
    { calculated: true, shortName: "NLR" }
  ),
  n("ggt", "GGT", "liver", "U/L", between(9, 48), between(10, 30)),
  n("amylase", "Amylase", "liver", "U/L", between(28, 100), between(35, 75)),
  n("lipase", "Lipase", "liver", "U/L", between(13, 60), between(20, 50)),
  n(
    "cystatin_c",
    "Cystatin C with eGFR",
    "kidney",
    "mg/L",
    between(0.62, 0.95),
    between(0.65, 0.85)
  ),
  n(
    "vitamin_d",
    "Vitamin D, 25-Hydroxy, Total",
    "micronutrients",
    "ng/mL",
    between(30, 100),
    between(50, 80),
    { shortName: "Vitamin D", isKey: true }
  ),
  n("b12_folate", "Vitamin B12 and Folate, Serum", "micronutrients", null, undefined, undefined, {
    resultType: "compound",
    components: [
      { label: "B12", normal: between(232, 1245), optimal: between(500, 900) },
      { label: "Folate", normal: gt(3), optimal: gt(10) },
    ],
  }),
  n(
    "magnesium_rbc",
    "Magnesium, RBC",
    "micronutrients",
    "mg/dL",
    between(4.2, 6.8),
    between(5.0, 6.5)
  ),
  n("zinc_rbc", "Zinc, RBC", "micronutrients", "mg/L", between(9.0, 14.7), between(10, 13)),
  n(
    "heavy_metals",
    "Heavy Metals Panel, Blood (lead, mercury, arsenic, cadmium)",
    "metals",
    null,
    { label: "Below limits", values: ["Within range", "Below limits", "Undetected"] },
    oneOf("Undetected"),
    { resultType: "categorical" }
  ),
  n("apoe_genotype", "APOE Genotype", "genetic", null, { any: true }, oneOf("E3/E3"), {
    resultType: "genotype",
    oneTime: true,
  }),
  // Hormone panels ("New Lab List"): the design prints no ranges or units.
  n("testosterone_total", "Testosterone, Total (LC/MS)", "hormones", null),
  n("testosterone_free", "Testosterone, Free", "hormones", null),
  n("shbg", "Sex Hormone Binding Globulin (SHBG)", "hormones", null, undefined, undefined, {
    shortName: "SHBG",
  }),
  n("dht", "Dihydrotestosterone (DHT)", "hormones", null),
  n("estradiol_ultrasensitive", "Estradiol, Ultrasensitive (LC/MS)", "hormones", null),
  n("fsh_lh", "FSH and LH", "hormones", null, undefined, undefined, {
    resultType: "compound",
    components: [{ label: "FSH" }, { label: "LH" }],
  }),
  n("psa_total", "PSA, Total", "hormones", null),
  n("progesterone", "Progesterone", "hormones", null),
  n("amh", "Anti-Müllerian Hormone (AMH)", "hormones", null, undefined, undefined, {
    shortName: "AMH",
  }),
  // DEXA metrics (8.0 Scans). Only the ranges the design prints are seeded.
  n("dexa_body_fat_pct", "Body Fat %", "body_composition", "%", undefined, undefined, {
    sexRanges: { female: { normal: between(21, 33) } },
  }),
  n("dexa_lean_mass_lb", "Lean Mass", "body_composition", "lb"),
  n("dexa_vat_cm2", "Visceral Fat (VAT)", "body_composition", "cm²"),
  n("dexa_hip_t_score", "Bone Density (Hip) T-Score", "body_composition", null),
  n("dexa_android_gynoid_ratio", "Android/Gynoid Ratio", "body_composition", null, lt(1.0)),
];
const HORMONE_PANEL_KEYS = [
  "testosterone_total",
  "testosterone_free",
  "shbg",
  "dht",
  "estradiol_ultrasensitive",
  "fsh_lh",
  "psa_total",
  "progesterone",
  "amh",
];
// The Group 30 "Full Panel": the 40 Labs-table rows plus the calculated ratios.
// LDL/HDL/Glucose are key-marker tiles outside that list; DEXA metrics are scans.
const NOT_FULL_PANEL = new Set([
  ...HORMONE_PANEL_KEYS,
  "ldl_cholesterol",
  "hdl_cholesterol",
  "glucose",
]);
export const FULL_PANEL_KEYS = BIOMARKER_SEED.filter(
  (s) => s.category !== "body_composition" && !NOT_FULL_PANEL.has(s.key)
).map((s) => s.key);
export const TEMPLATE_SEED = [
  { key: "full_panel", name: "Full Panel", keys: FULL_PANEL_KEYS },
  {
    key: "male_hormone_panel",
    name: "Male Hormone Panel",
    keys: [
      "testosterone_total",
      "testosterone_free",
      "shbg",
      "dht",
      "estradiol_ultrasensitive",
      "fsh_lh",
      "psa_total",
    ],
  },
  {
    key: "female_hormone_panel",
    name: "Female Hormone Panel",
    keys: [
      "estradiol_ultrasensitive",
      "progesterone",
      "fsh_lh",
      "testosterone_total",
      "testosterone_free",
      "shbg",
      "amh",
    ],
  },
];

/** Idempotent: inserts missing markers/templates, never overwrites clinic edits. */
export async function seedClinicalCatalog(organizationId: string) {
  for (const [sortOrder, { resultType = "numeric", ...seed }] of BIOMARKER_SEED.entries())
    await Biomarker.updateOne(
      { organizationId, key: seed.key },
      { $setOnInsert: { organizationId, resultType, sortOrder, ...seed } },
      { upsert: true }
    );
  const ids = new Map(
    (await Biomarker.find({ organizationId }).select("key").lean()).map((b) => [b.key, b._id])
  );
  for (const { keys, ...template } of TEMPLATE_SEED)
    await LabPanelTemplate.updateOne(
      { organizationId, key: template.key },
      { $setOnInsert: { organizationId, ...template, biomarkerIds: keys.map((k) => ids.get(k)) } },
      { upsert: true }
    );
}
