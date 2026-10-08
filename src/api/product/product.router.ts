import type { Request } from "express";
import { Router } from "express";
import { z } from "zod";
import { idParams, secured } from "../../common/http.js";
import { orderList, productCreate, productPatch, shipBody } from "./product.schema.js";
import { createProduct, listProductOrders, listProducts, patchProduct } from "./product.service.js";
import { markDelivered, markShipped, staffCancel } from "./productOrder.service.js";
import { orderDetail } from "./productOrder.view.js";

export const productRouter = Router();
const catalog = (level: "view" | "edit") => ({ module: "SERVICES", level }) as const;
const fulfilment = (level: "view" | "edit") => ({ module: "BILLING", level }) as const;
const idOf = (req: Request) => String(req.params["id"]);
const noBody = z.object({}).strict();

secured(productRouter, "get", "/products", catalog("view"), {}, listProducts);
secured(
  productRouter,
  "post",
  "/products",
  catalog("edit"),
  { body: productCreate },
  createProduct,
  201
);
secured(
  productRouter,
  "patch",
  "/products/:id",
  catalog("edit"),
  { params: idParams, body: productPatch },
  patchProduct
);
secured(
  productRouter,
  "get",
  "/product-orders",
  fulfilment("view"),
  { query: orderList },
  listProductOrders
);
secured(
  productRouter,
  "post",
  "/product-orders/:id/ship",
  fulfilment("edit"),
  { params: idParams, body: shipBody },
  async (req) =>
    orderDetail(await markShipped(req, idOf(req), req.body as z.output<typeof shipBody>))
);
secured(
  productRouter,
  "post",
  "/product-orders/:id/deliver",
  fulfilment("edit"),
  { params: idParams, body: noBody },
  async (req) => orderDetail(await markDelivered(req, idOf(req)))
);
secured(
  productRouter,
  "post",
  "/product-orders/:id/cancel",
  fulfilment("edit"),
  { params: idParams, body: noBody },
  async (req) => orderDetail(await staffCancel(req, idOf(req)))
);
