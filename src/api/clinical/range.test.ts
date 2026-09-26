import { describe, expect, it } from "vitest";
import { computeStatus, formatRange, resolveReference } from "./range.js";

const numeric = { resultType: "numeric" as const };
describe("computeStatus", () => {
  it("classifies numeric values against the normal range, honouring exclusive bounds", () => {
    const reference = {
      normal: { max: 200, maxExclusive: true },
      optimal: { max: 170, maxExclusive: true },
    };
    expect(computeStatus({ ...numeric, reference }, 185)).toEqual({
      status: "normal",
      withinOptimal: false,
    });
    expect(computeStatus({ ...numeric, reference }, 150)).toEqual({
      status: "normal",
      withinOptimal: true,
    });
    expect(computeStatus({ ...numeric, reference }, 200)).toEqual({
      status: "high",
      withinOptimal: false,
    });
    const inclusive = { normal: { min: 30, max: 100 }, optimal: { min: 50, max: 80 } };
    expect(computeStatus({ ...numeric, reference: inclusive }, 22).status).toBe("low");
    expect(computeStatus({ ...numeric, reference: inclusive }, 30).status).toBe("normal");
    expect(computeStatus({ ...numeric, reference: inclusive }, 100).status).toBe("normal");
    const floor = { normal: { min: 5, minExclusive: true } };
    expect(computeStatus({ ...numeric, reference: floor }, 5)).toEqual({
      status: "low",
      withinOptimal: null,
    });
  });
  it("never guesses: no range means no status, and a missing value means no status", () => {
    expect(computeStatus({ ...numeric, reference: {} }, 12)).toEqual({
      status: null,
      withinOptimal: null,
    });
    expect(computeStatus({ ...numeric, reference: { normal: { max: 5 } } }, null)).toEqual({
      status: null,
      withinOptimal: null,
    });
  });
  it("matches categorical and genotype values case-insensitively, and 'any' is normal", () => {
    const pattern = {
      resultType: "categorical" as const,
      reference: {
        normal: { values: ["Pattern A", "Pattern B"] },
        optimal: { values: ["Pattern A"] },
      },
    };
    expect(computeStatus(pattern, " pattern b ")).toEqual({
      status: "normal",
      withinOptimal: false,
    });
    expect(computeStatus(pattern, "Pattern C")).toEqual({
      status: "abnormal",
      withinOptimal: false,
    });
    const apoe = {
      resultType: "genotype" as const,
      reference: { normal: { any: true }, optimal: { values: ["E3/E3"] } },
    };
    expect(computeStatus(apoe, "E3/E4")).toEqual({ status: "normal", withinOptimal: false });
    expect(computeStatus(apoe, "E3/E3")).toEqual({ status: "normal", withinOptimal: true });
  });
  it("rolls compound components up without inventing a combined rule", () => {
    const b12 = {
      resultType: "compound" as const,
      reference: {
        components: [
          { label: "B12", normal: { min: 232, max: 1245 }, optimal: { min: 500, max: 900 } },
          {
            label: "Folate",
            normal: { min: 3, minExclusive: true },
            optimal: { min: 10, minExclusive: true },
          },
        ],
      },
    };
    expect(computeStatus(b12, [612, 14.2])).toEqual({ status: "normal", withinOptimal: true });
    expect(computeStatus(b12, [612, 2])).toEqual({ status: "low", withinOptimal: false });
    expect(computeStatus(b12, [1300, 2])).toEqual({ status: "abnormal", withinOptimal: false });
    expect(computeStatus(b12, [1300, 14])).toEqual({ status: "high", withinOptimal: false });
  });
});

describe("resolveReference", () => {
  const marker = {
    normal: { max: 40 },
    optimal: { max: 30 },
    sexRanges: { female: { normal: { min: 21, max: 33 } } },
  };
  it("uses the sex-specific range when one exists for the member's sex", () => {
    expect(resolveReference(marker, "female")).toEqual({
      normal: { min: 21, max: 33 },
      optimal: { max: 30 },
    });
    expect(resolveReference(marker, "male")).toEqual({ normal: { max: 40 }, optimal: { max: 30 } });
    expect(resolveReference(marker, undefined)).toEqual({
      normal: { max: 40 },
      optimal: { max: 30 },
    });
  });
});

describe("formatRange", () => {
  it("prints the catalog notation", () => {
    expect(formatRange({ max: 200, maxExclusive: true })).toBe("< 200");
    expect(formatRange({ min: 5, minExclusive: true })).toBe("> 5");
    expect(formatRange({ min: 110, max: 180 })).toBe("110–180");
    expect(formatRange({ values: ["Pattern A", "Pattern B"] })).toBe("Pattern A or Pattern B");
    expect(formatRange({ any: true })).toBe("Any");
    expect(formatRange({ label: "In range", values: ["Complete"] })).toBe("In range");
    expect(formatRange(undefined)).toBeNull();
  });
});
