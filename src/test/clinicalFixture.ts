import { Biomarker } from "../api/clinical/catalog.model.js";
import { seedClinicalCatalog } from "../api/clinical/catalog.seed.js";
import { ORG } from "./memberFixture.js";

/** Seeds the clinical catalog for the test org; returns biomarker ids by key. */
export async function catalogIds(): Promise<Record<string, string>> {
  await seedClinicalCatalog(ORG);
  const rows = await Biomarker.find({ organizationId: ORG }).select("key").lean();
  return Object.fromEntries(rows.map((r) => [r.key, String(r._id)]));
}
export const result = (biomarkerId: string | undefined, value: unknown) => ({ biomarkerId, value });
