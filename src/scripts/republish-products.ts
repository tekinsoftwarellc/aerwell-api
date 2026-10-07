import mongoose from "mongoose";
import { republishProducts } from "../api/product/productCatalog.js";
import { env } from "../config/env.js";

// Operator-run once after the per_member visibility deploy: Alfred's copies still say "all" until each
// product is sent again. Prints a count only.
async function main(): Promise<void> {
  if (!env.AERWELL_ORG_ID) throw new Error("AERWELL_ORG_ID is not set");
  await mongoose.connect(env.MONGODB_URI);
  try {
    console.log(`Republished ${await republishProducts(env.AERWELL_ORG_ID)} products.`);
  } finally {
    await mongoose.disconnect();
  }
}
main().catch(() => {
  console.error(
    "Product republish failed. Check AERWELL_ORG_ID, the outbox flag and database connectivity."
  );
  process.exitCode = 1;
});
