// Reference-range evaluation for lab and scan results (decision D15): the
// server derives status from catalog data only. No clinical formula lives here;
// a result without a catalog range has no status rather than a guessed one.
export interface Range {
  // Nullable because stored (mongoose) ranges read back unset fields as null.
  min?: number | null;
  max?: number | null;
  minExclusive?: boolean | null;
  maxExclusive?: boolean | null;
  /** Categorical / genotype / status values that satisfy the range. */
  values?: string[] | null;
  /** Every value satisfies the range ("Any"). */
  any?: boolean | null;
  /** Display text when the lab prints words instead of numbers ("In range"). */
  label?: string | null;
}
export interface Component {
  label: string;
  unit?: string | null;
  normal?: Range | null;
  optimal?: Range | null;
}
export interface Reference {
  normal?: Range | null;
  optimal?: Range | null;
  components?: Component[];
}
export type ResultType = "numeric" | "categorical" | "genotype" | "compound";
export type Status = "normal" | "high" | "low" | "abnormal" | null;
export type ResultValue = number | string | number[] | null | undefined;
export const OUT_OF_RANGE: ReadonlySet<Status> = new Set(["high", "low", "abnormal"]);

const isNum = (v: unknown): v is number => typeof v === "number";
const hasBounds = (range?: Range | null) => isNum(range?.min) || isNum(range?.max);
function position(range: Range | undefined | null, value: number): "low" | "high" | "in" | null {
  if (!hasBounds(range) || !range) return null;
  if (isNum(range.min) && (range.minExclusive ? value <= range.min : value < range.min))
    return "low";
  if (isNum(range.max) && (range.maxExclusive ? value >= range.max : value > range.max))
    return "high";
  return "in";
}
const norm = (value: string) => value.trim().toLowerCase();
function matches(range: Range | undefined | null, value: string): boolean | null {
  if (range?.any) return true;
  if (!range?.values?.length) return null;
  return range.values.some((v) => norm(v) === norm(value));
}
function numericStatus(reference: Reference, value: number) {
  const where = position(reference.normal, value);
  const optimal = position(reference.optimal, value);
  return {
    status: where === null ? null : where === "in" ? "normal" : where,
    withinOptimal: optimal === null ? null : optimal === "in",
  } as const;
}
function compoundStatus(components: Component[], values: number[]) {
  const parts = components.map((c, i) =>
    values[i] === undefined ? { status: null, withinOptimal: null } : numericStatus(c, values[i])
  );
  const statuses = new Set(parts.map((p) => p.status).filter((s) => s !== null));
  const status: Status =
    statuses.size === 0
      ? null
      : statuses.has("high") && statuses.has("low")
        ? "abnormal"
        : statuses.has("high")
          ? "high"
          : statuses.has("low")
            ? "low"
            : "normal";
  const optimal = parts.map((p) => p.withinOptimal);
  return {
    status,
    withinOptimal: optimal.some((o) => o === null) ? null : optimal.every(Boolean),
  };
}
export function computeStatus(
  marker: { resultType: ResultType; reference: Reference },
  value: ResultValue
): { status: Status; withinOptimal: boolean | null } {
  const none = { status: null, withinOptimal: null };
  if (value === null || value === undefined || value === "") return none;
  const { reference } = marker;
  if (marker.resultType === "compound")
    return Array.isArray(value) ? compoundStatus(reference.components ?? [], value) : none;
  if (marker.resultType === "numeric")
    return typeof value === "number" ? numericStatus(reference, value) : none;
  if (typeof value !== "string") return none;
  const normal = matches(reference.normal, value);
  return {
    status: normal === null ? null : normal ? "normal" : "abnormal",
    withinOptimal: matches(reference.optimal, value),
  };
}

/** Catalog ranges for this member: a sex-specific override wins per bound set. */
export function resolveReference(
  marker: {
    normal?: Range | null;
    optimal?: Range | null;
    components?: Component[] | null;
    sexRanges?: Partial<
      Record<"male" | "female", { normal?: Range | null; optimal?: Range | null } | null>
    > | null;
  },
  sex: string | null | undefined
): Reference {
  const override = sex === "male" || sex === "female" ? marker.sexRanges?.[sex] : undefined;
  const normal = override?.normal ?? marker.normal ?? undefined;
  const optimal = override?.optimal ?? marker.optimal ?? undefined;
  return {
    ...(normal ? { normal } : {}),
    ...(optimal ? { optimal } : {}),
    ...(marker.components?.length ? { components: marker.components } : {}),
  };
}

const fmt = (n: number) => String(n);
export function formatRange(range: Range | undefined | null): string | null {
  if (!range) return null;
  if (range.label) return range.label;
  if (range.any) return "Any";
  if (range.values?.length) return range.values.join(" or ");
  const { min, max } = range;
  if (isNum(min) && isNum(max)) return `${fmt(min)}–${fmt(max)}`;
  if (isNum(max)) return `${range.maxExclusive ? "<" : "≤"} ${fmt(max)}`;
  if (isNum(min)) return `${range.minExclusive ? ">" : "≥"} ${fmt(min)}`;
  return null;
}
/** "232–1245 / > 3" for compound markers, one label per component. */
export function referenceLabels(reference: Reference) {
  if (reference.components?.length) {
    const join = (key: "normal" | "optimal") => {
      const parts = reference.components?.map((c) => formatRange(c[key]) ?? "—") ?? [];
      return parts.every((p) => p === "—") ? null : parts.join(" / ");
    };
    return { normalLabel: join("normal"), optimalLabel: join("optimal") };
  }
  return {
    normalLabel: formatRange(reference.normal),
    optimalLabel: formatRange(reference.optimal),
  };
}
