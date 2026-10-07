import type { Request } from "express";
import type { z } from "zod";
import { ConflictError, NotFoundError } from "../../common/errors/AppError.js";
import { actor, pagination } from "../../common/http.js";
import { audit } from "../audit/audit.js";
import { Member } from "../member/member.model.js";
import { attachServiceImage } from "../service/serviceImage.service.js";
import { SupplementProduct } from "../supplement/supplement.js";
import type { orderList, productCreate, productPatch } from "./product.schema.js";
import { productImageLink, productRef, publishProductChange } from "./productCatalog.js";
import { ProductOrder } from "./productOrder.model.js";
import { orderDetail } from "./productOrder.view.js";

type Product = {
  _id: unknown;
  sku: string;
  name: string;
  brand?: string | null;
  size?: string | null;
  description?: string | null;
  priceCents: number;
  stock: number;
  weightGrams?: number | null;
  forSale: boolean;
  active: boolean;
  imageKey?: string | null;
};
export const productView = (p: Product) => ({
  id: String(p._id),
  sku: p.sku,
  partnerRef: productRef(p.sku),
  name: p.name,
  brand: p.brand ?? null,
  size: p.size ?? null,
  description: p.description ?? "",
  priceCents: p.priceCents,
  stock: p.stock,
  weightGrams: p.weightGrams ?? null,
  forSale: p.forSale,
  active: p.active,
  imageUrl: productImageLink(p) ?? null,
});

const orgOf = (req: Request) => actor(req).organizationId;

export async function listProducts(req: Request) {
  const rows = await SupplementProduct.find({ organizationId: orgOf(req) })
    .sort({ name: 1, _id: 1 })
    .lean();
  return { items: rows.map(productView) };
}

export async function createProduct(req: Request) {
  const { imageUploadId, ...body } = req.body as z.output<typeof productCreate>;
  const organizationId = orgOf(req);
  const imageKey = imageUploadId
    ? await attachServiceImage(organizationId, String(actor(req)._id), imageUploadId)
    : undefined;
  try {
    const row = await SupplementProduct.create({ ...body, organizationId, imageKey });
    await audit(req, "created", "SupplementProduct", String(row._id));
    await publishProductChange(organizationId, row._id);
    return productView(row);
  } catch (error) {
    if ((error as { code?: number }).code === 11000)
      throw new ConflictError("That SKU is already in use", undefined, "SKU_EXISTS");
    throw error;
  }
}

/** `stock` is an absolute count set by staff (a stocktake); orders adjust it atomically by delta. */
export async function patchProduct(req: Request) {
  const { imageUploadId, expectedStock, ...body } = req.body as z.output<typeof productPatch>;
  const organizationId = orgOf(req);
  const imageKey = imageUploadId
    ? await attachServiceImage(organizationId, String(actor(req)._id), imageUploadId)
    : undefined;
  const where = { _id: req.params["id"], organizationId };
  // A stocktake sent with the count the editor saw only applies if no order moved it since.
  const row = await SupplementProduct.findOneAndUpdate(
    {
      ...where,
      ...(body.stock !== undefined && expectedStock !== undefined ? { stock: expectedStock } : {}),
    },
    { $set: { ...body, ...(imageKey ? { imageKey } : {}) } },
    { new: true }
  );
  if (!row) {
    if (await SupplementProduct.exists(where))
      throw new ConflictError(
        "Stock changed since you opened this product",
        undefined,
        "STOCK_CHANGED"
      );
    throw new NotFoundError("Product not found");
  }
  await audit(req, "updated", "SupplementProduct", String(row._id));
  await publishProductChange(organizationId, row._id);
  return productView(row);
}

/** Staff fulfilment list. The shipping address is read here and nowhere else, and the read is audited. */
export async function listProductOrders(req: Request) {
  const q = req.query as unknown as z.output<typeof orderList>;
  const filter = { organizationId: orgOf(req), ...(q.status ? { status: q.status } : {}) };
  const [rows, total] = await Promise.all([
    ProductOrder.find(filter)
      .select("+shippingAddress")
      .sort({ createdAt: -1, _id: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean(),
    ProductOrder.countDocuments(filter),
  ]);
  const members = await Member.find({ _id: { $in: rows.map((r) => r.memberId) } })
    .select("firstName lastName")
    .lean();
  const nameOf = new Map(
    members.map((m) => [String(m._id), `${m.firstName} ${m.lastName ?? ""}`.trim()])
  );
  await audit(req, "listed", "ProductOrder", "list");
  return {
    items: rows.map((r) => ({
      ...orderDetail(r),
      id: String(r._id),
      memberId: String(r.memberId),
      memberName: nameOf.get(String(r.memberId)) ?? "",
      shippingAddress: r.shippingAddress ?? null,
      createdAt: r.createdAt,
      paidAt: r.paidAt ?? null,
    })),
    pagination: pagination(q.page, q.limit, total),
  };
}
