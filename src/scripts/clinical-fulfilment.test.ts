import { describe, expect, it } from "vitest";
import { Service } from "../api/service/service.model.js";
import { bookingWorld } from "../test/appointmentFixture.js";
import { CLINICAL_SLUGS, setClinicalFulfilment } from "./clinical-fulfilment.service.js";

type State = Record<string, { fulfilment: string; updatedAt: number; version?: number }>;
const state = async (): Promise<State> =>
  Object.fromEntries(
    (await Service.find({ organizationId: "org-test" }).lean()).map((s) => [
      s.slug ?? "",
      {
        fulfilment: s.fulfilment,
        updatedAt: s.updatedAt.getTime(),
        version: (s as { version?: number }).version,
      },
    ])
  );

describe("setClinicalFulfilment", () => {
  it("dry run writes nothing, apply flips only the two clinical services, a re-run is a no-op", async () => {
    await bookingWorld();
    const before = await state();
    expect(Object.values(before).every((s) => s.fulfilment === "standard")).toBe(true);
    const dry = await setClinicalFulfilment("org-test", { dryRun: true });
    expect([dry.changed.sort(), dry.missing]).toEqual([[...CLINICAL_SLUGS].sort(), []]);
    expect(await state()).toEqual(before);
    const applied = await setClinicalFulfilment("org-test", { dryRun: false });
    expect(applied.changed.sort()).toEqual([...CLINICAL_SLUGS].sort());
    const after = await state();
    for (const [slug, row] of Object.entries(after) as [string, State[string]][]) {
      const clinical = CLINICAL_SLUGS.includes(slug ?? "");
      expect(row.fulfilment).toBe(clinical ? "clinical" : "standard");
      if (clinical) expect(row.updatedAt).toBeGreaterThan(before[slug ?? ""]?.updatedAt ?? 0);
      else expect(row).toEqual(before[slug ?? ""]);
    }
    const again = await setClinicalFulfilment("org-test", { dryRun: false });
    expect([again.changed, again.alreadyClinical]).toEqual([[], 2]);
    expect(await state()).toEqual(after);
  });
  it("reports a missing service instead of failing", async () => {
    const report = await setClinicalFulfilment("org-test", { dryRun: true });
    expect(report.missing).toEqual(CLINICAL_SLUGS);
  });
});
