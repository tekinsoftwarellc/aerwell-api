import { extraCategories } from "../catalog/catalog.seed-data.js";
import { seedClientCatalog } from "../catalog/catalog.seed.js";
import { ServiceCategory } from "./service.model.js";
// Colors sampled at the six legend dot centers in 1616-2-appointments-today.png.
export const categoryDefaults = [
  { name: "Aesthetic medicine", color: "#4d260f" },
  { name: "Body composition", color: "#bd6e01" },
  { name: "Cardiometabolic", color: "#8d3400" },
  { name: "Hormone & endocrine", color: "#20221b" },
  { name: "Infusion & injectable", color: "#889b0e" },
  { name: "Performance & diagnostic", color: "#80886c" },
];
export async function seedCategories(organizationId: string): Promise<void> {
  for (const [sortOrder, category] of [...categoryDefaults, ...extraCategories].entries())
    await ServiceCategory.updateOne(
      { organizationId, name: category.name },
      { $setOnInsert: { organizationId, ...category, sortOrder } },
      { upsert: true }
    );
}
export async function seedCatalog(organizationId: string): Promise<void> {
  await seedCategories(organizationId);
  await seedClientCatalog(organizationId);
}
