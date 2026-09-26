import type { Request } from "express";
import { Router } from "express";
import { type InferSchemaType, Schema, model } from "mongoose";
import { z } from "zod";
import { NotFoundError } from "../../common/errors/AppError.js";
import { actor, idParams, objectId, secured } from "../../common/http.js";
import { Appointment } from "../appointment/appointment.model.js";
import { auditRead, auditedWrite, byMember, clinicalMember } from "../clinical/clinical.shared.js";

/**
 * Supplement orders (D12, frame 10.4) as DRAFT-ONLY records. The catalog and
 * fulfilment partner are undecided, so nothing is charged, placed or shipped:
 * the only status is `draft`. Products are a seeded placeholder catalog.
 */
const org = { type: String, required: true };
const productSchema = new Schema(
  {
    organizationId: org,
    sku: { type: String, required: true },
    name: { type: String, required: true },
    brand: { type: String, default: null },
    size: { type: String, default: null },
    priceCents: { type: Number, required: true, min: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);
productSchema.index({ organizationId: 1, sku: 1 }, { unique: true });
export const SupplementProduct = model("SupplementProduct", productSchema);

export const FULFILMENT = ["ship", "pickup"] as const;
export const ORDER_STATUSES = ["draft"] as const;
const orderSchema = new Schema(
  {
    organizationId: org,
    memberId: { type: Schema.Types.ObjectId, ref: "Member", required: true },
    prescribedById: { type: Schema.Types.ObjectId, ref: "StaffMember", required: true },
    originAppointmentId: { type: Schema.Types.ObjectId, default: null },
    productId: { type: Schema.Types.ObjectId, required: true },
    product: {
      name: { type: String, required: true },
      brand: { type: String, default: null },
      priceCents: { type: Number, required: true },
    },
    directions: { type: String, required: true },
    durationDays: { type: Number, required: true },
    qty: { type: Number, required: true },
    fulfillment: { type: String, enum: FULFILMENT, required: true },
    autoRefill: { type: Boolean, default: false },
    noteToMember: { type: String, default: null },
    pricing: {
      subtotalCents: { type: Number, required: true },
      discountCents: { type: Number, default: 0 },
      shippingCents: { type: Number, default: 0 },
      totalCents: { type: Number, required: true },
    },
    status: { type: String, enum: ORDER_STATUSES, default: "draft" },
  },
  { timestamps: true }
);
orderSchema.index({ organizationId: 1, memberId: 1, createdAt: -1 });
export const SupplementOrder = model("SupplementOrder", orderSchema);
export type SupplementOrderData = InferSchemaType<typeof orderSchema>;

/** Placeholder catalog until the client picks a partner (U14). Never overwrites edits. */
const PLACEHOLDER_PRODUCTS = [
  ["vit-d3-k2-10000", "Vitamin D3 + K2 10,000 IU", "Thorne Research", "60 capsules", 3400],
  ["omega-3-1000", "Omega-3 Fish Oil 1000mg", "Nordic Naturals", "120 softgels", 3800],
  ["probiotic-50b", "Daily Probiotic 50B", "Seed", "30 capsules", 4900],
  ["magnesium-glycinate", "Magnesium Glycinate 200mg", "Pure Encapsulations", "90 capsules", 2600],
] as const;
export async function seedSupplementCatalog(organizationId: string) {
  for (const [sku, name, brand, size, priceCents] of PLACEHOLDER_PRODUCTS)
    await SupplementProduct.updateOne(
      { organizationId, sku },
      { $setOnInsert: { organizationId, sku, name, brand, size, priceCents } },
      { upsert: true }
    );
}

const text = (max: number) => z.string().trim().max(max);
export const orderBody = z
  .object({
    productId: objectId,
    directions: text(300).min(1),
    durationDays: z.number().int().min(1).max(365),
    qty: z.number().int().min(1).max(12),
    fulfillment: z.enum(FULFILMENT),
    autoRefill: z.boolean().default(false),
    noteToMember: text(2000).optional(),
    originAppointmentId: objectId.optional(),
  })
  .strict();

async function createOrder(req: Request) {
  const member = await clinicalMember(req, "PROTOCOLS", true);
  const body = req.body as z.infer<typeof orderBody>;
  const product = await SupplementProduct.findOne({
    _id: body.productId,
    organizationId: member.organizationId,
    active: true,
  }).lean();
  if (!product) throw new NotFoundError("Product not found", "PRODUCT_NOT_FOUND");
  if (
    body.originAppointmentId &&
    !(await Appointment.exists({ _id: body.originAppointmentId, ...byMember(member) }))
  )
    throw new NotFoundError("Appointment not found");
  const subtotalCents = product.priceCents * body.qty;
  return auditedWrite(
    req,
    member,
    { action: "drafted", targetType: "SupplementOrder" },
    async (s) => {
      const [row] = await SupplementOrder.create(
        [
          {
            ...byMember(member),
            ...body,
            prescribedById: actor(req)._id,
            product: { name: product.name, brand: product.brand, priceCents: product.priceCents },
            // Member pricing and shipping are not configured (no catalog decision).
            pricing: {
              subtotalCents,
              discountCents: 0,
              shippingCents: 0,
              totalCents: subtotalCents,
            },
          },
        ],
        { session: s }
      );
      if (!row) throw new Error("Order not created");
      return row.toObject();
    }
  );
}
async function listOrders(req: Request) {
  const member = await clinicalMember(req, "PROTOCOLS");
  await auditRead(req, "SupplementOrders", member);
  const items = await SupplementOrder.find(byMember(member))
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
  return { items, fulfilment: "unconfigured" };
}
const listProducts = async (req: Request) => ({
  items: await SupplementProduct.find({ organizationId: actor(req).organizationId, active: true })
    .sort({ name: 1, _id: 1 })
    .lean(),
});

export const supplementRouter = Router();
const can = (level: "view" | "edit") => ({ module: "PROTOCOLS", level }) as const;
secured(supplementRouter, "get", "/supplement-products", can("view"), {}, listProducts);
secured(
  supplementRouter,
  "get",
  "/members/:id/supplement-orders",
  can("view"),
  { params: idParams },
  listOrders
);
secured(
  supplementRouter,
  "post",
  "/members/:id/supplement-orders",
  can("edit"),
  { params: idParams, body: orderBody },
  createOrder,
  201
);

export const supplementPaths: Record<string, Record<string, unknown>> = {
  "/api/v1/supplement-products": {
    get: op(
      "Placeholder supplement catalog (PROTOCOLS view). The real catalog is undecided (D12)."
    ),
  },
  "/api/v1/members/{id}/supplement-orders": {
    get: op("A member's draft supplement orders (PROTOCOLS view). Audited.", true),
    post: op(
      "Save a DRAFT supplement order {productId, directions, durationDays, qty, fulfillment ship|pickup, autoRefill, noteToMember?, originAppointmentId?} (PROTOCOLS edit). Nothing is charged, placed or shipped; status is always draft. Audited.",
      true
    ),
  },
};
function op(summary: string, member = false) {
  return {
    summary,
    tags: ["Supplement orders"],
    security: [{ staffBearer: [] }],
    parameters: member
      ? [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", pattern: "^[a-f0-9]{24}$" },
          },
        ]
      : [],
    responses: {
      200: { description: "Success envelope" },
      201: { description: "Created" },
      400: { description: "VALIDATION_ERROR" },
      401: { description: "Staff session required" },
      403: { description: "Missing PROTOCOLS permission" },
      404: { description: "Member, PRODUCT_NOT_FOUND or appointment not found in scope" },
      409: { description: "MEMBER_ARCHIVED" },
    },
  };
}
