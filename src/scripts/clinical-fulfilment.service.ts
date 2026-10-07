import { publishCatalogChange } from "../api/alfred-partner/outbox/catalogEvents.js";
import { Service } from "../api/service/service.model.js";

/** Q1: the only services whose results Aerwell holds (lab panel, DEXA scan). */
export const CLINICAL_SLUGS = ["comprehensive-blood-panel", "dexa-scan"];

/**
 * Mark the clinical services `fulfilment: clinical`. Idempotent: a service already clinical is left
 * alone (no updatedAt bump), so a re-run changes nothing. A bump is what makes Alfred's incremental
 * catalog pull (and the `catalog.upserted` event) pick the change up. Counts and slugs only.
 */
export async function setClinicalFulfilment(organizationId: string, options: { dryRun: boolean }) {
  const rows = await Service.find({ organizationId, slug: { $in: CLINICAL_SLUGS } })
    .select("slug fulfilment")
    .lean();
  const missing = CLINICAL_SLUGS.filter((slug) => !rows.some((r) => r.slug === slug));
  const todo = rows.filter((r) => r.fulfilment !== "clinical");
  if (!options.dryRun && todo.length) {
    await Service.updateMany(
      { _id: { $in: todo.map((r) => r._id) } },
      { $set: { fulfilment: "clinical", updatedAt: new Date() }, $inc: { version: 1 } },
      { timestamps: false }
    );
  }
  // Announced for every row on apply, not just the changed ones: the event key is the row's updatedAt,
  // so a re-run after a failed publish repairs it and never duplicates one that went out.
  if (!options.dryRun)
    await publishCatalogChange(
      organizationId,
      rows.map((r) => r._id)
    );
  return {
    dryRun: options.dryRun,
    alreadyClinical: rows.length - todo.length,
    changed: todo.map((r) => r.slug ?? ""),
    missing,
  };
}
