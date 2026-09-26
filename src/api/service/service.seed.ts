import { MembershipPlan, ServiceCategory } from "./service.model.js";
// Colors sampled at the six legend dot centers in 1616-2-appointments-today.png.
export const categoryDefaults = [
  { name: "Aesthetic medicine", color: "#4d260f" },
  { name: "Body composition", color: "#bd6e01" },
  { name: "Cardiometabolic", color: "#8d3400" },
  { name: "Hormone & endocrine", color: "#20221b" },
  { name: "Infusion & injectable", color: "#889b0e" },
  { name: "Performance & diagnostic", color: "#80886c" },
];
export async function seedCatalog(organizationId: string): Promise<void> {
  for (const [sortOrder, category] of categoryDefaults.entries())
    await ServiceCategory.updateOne(
      { organizationId, name: category.name },
      { $setOnInsert: { organizationId, ...category, sortOrder } },
      { upsert: true }
    );
  for (const plan of [
    {
      name: "Aerwell",
      brand: "aerwell",
      tiers: [
        { id: "tier-1", name: "Tier 1" },
        { id: "tier-2", name: "Tier 2" },
        { id: "tier-3", name: "Tier 3" },
      ],
    },
    { name: "Everhaus", brand: "everhaus", tiers: [{ id: "membership", name: "Membership" }] },
  ])
    await MembershipPlan.updateOne(
      { organizationId, brand: plan.brand },
      {
        $setOnInsert: {
          organizationId,
          ...plan,
          tiers: plan.tiers.map((t) => ({
            ...t,
            billingTerm: "monthly",
            pricePending: true,
            active: true,
          })),
        },
      },
      { upsert: true }
    );
}
