import type { Request, Response } from "express";
import type { z } from "zod";
import { BadRequestError } from "../../common/errors/AppError.js";
import { ServiceResponse } from "../../common/models/serviceResponse.js";
import { type BookingBody, createAlfredBooking, ownedBooking } from "./partner.bookings.service.js";
import { bookingView, loadRefs } from "./partner.bookings.view.js";
import {
  cancelAlfredBooking,
  cancellationQuote,
  checkInAlfredBooking,
  rescheduleAlfredBooking,
} from "./partner.lifecycle.service.js";
import type { cancelBody, rescheduleBody } from "./partner.schema.js";

const refOf = (req: Request) => String(req.params["bookingRef"]);
const send = (res: Response, message: string, data: unknown, status = 200) =>
  res.status(status).json(ServiceResponse.success(message, data, status));

/** `POST /bookings` (§5.7). Alfred has priced and (or will) charge: this records, it never asks. */
export async function createBooking(req: Request, res: Response): Promise<void> {
  const body = req.body as BookingBody;
  if (body.accountId !== req.partner?.accountId)
    throw new BadRequestError("accountId must match the acting member");
  const row = await createAlfredBooking(req, body, String(req.get("Idempotency-Key")));
  send(res, "Booking created", bookingView(row, await loadRefs([row])), 201);
}

export async function getBooking(req: Request, res: Response): Promise<void> {
  const row = await ownedBooking(req, refOf(req));
  send(res, "Booking", bookingView(row, await loadRefs([row])));
}

export async function rescheduleBooking(req: Request, res: Response): Promise<void> {
  const { slotRef } = req.body as z.output<typeof rescheduleBody>;
  const moved = await rescheduleAlfredBooking(req, await ownedBooking(req, refOf(req)), slotRef);
  send(res, "Booking rescheduled", bookingView(moved, await loadRefs([moved]), "rescheduled"));
}

export async function getCancellationQuote(req: Request, res: Response): Promise<void> {
  send(res, "Cancellation quote", await cancellationQuote(await ownedBooking(req, refOf(req))));
}

export async function cancelBooking(req: Request, res: Response): Promise<void> {
  const { reason } = req.body as z.output<typeof cancelBody>;
  send(
    res,
    "Booking cancelled",
    await cancelAlfredBooking(req, await ownedBooking(req, refOf(req)), reason)
  );
}

export async function checkInBooking(req: Request, res: Response): Promise<void> {
  send(res, "Checked in", await checkInAlfredBooking(req, await ownedBooking(req, refOf(req))));
}
