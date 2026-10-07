import type { Request, Response } from "express";
import { ServiceResponse } from "../../common/models/serviceResponse.js";
import {
  type OrderBody,
  cancelForMember,
  ownedOrder,
  placeOrder,
} from "../product/productOrder.service.js";
import { orderDetail, orderView } from "../product/productOrder.view.js";

const refOf = (req: Request) => String(req.params["orderRef"]);
const send = (res: Response, message: string, data: unknown, status = 200) =>
  res.status(status).json(ServiceResponse.success(message, data, status));

/** `POST /orders` (§5.10): price, reserve and record a product order. Alfred charges `totals.totalCents`. */
export async function createOrder(req: Request, res: Response): Promise<void> {
  send(res, "Order placed", orderView(await placeOrder(req, req.body as OrderBody)), 201);
}

export async function getOrder(req: Request, res: Response): Promise<void> {
  send(res, "Order", orderDetail(await ownedOrder(req, refOf(req))));
}

/** The reason is accepted and ignored: free text is never stored or logged here. */
export async function cancelOrder(req: Request, res: Response): Promise<void> {
  send(res, "Order cancelled", await cancelForMember(req, refOf(req)));
}
