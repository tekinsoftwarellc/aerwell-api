import { AppError, ConflictError, ValidationError } from "../../common/errors/AppError.js";

/**
 * The only helpers that put a machine-readable code in the response `data`
 * (Partner Contract v1 §4.1, Appendix B). A refusal travels as `data.code`, never as prose.
 */

/** A 409 state conflict. Always carries a code (§4.8). */
export const contractConflict = (code: string, message: string): ConflictError =>
  new ConflictError(message, { code });

/** A 403 refusal with a code (`ORG_MISMATCH`). */
export const contractForbidden = (code: string, message: string): AppError =>
  new AppError(message, 403, true, { code });

/** A 422: contract-version mismatch and idempotency mismatch are the only two. */
export const contractUnprocessable = (code: string, message: string): AppError =>
  new AppError(message, 422, true, { code });

/**
 * Aerwell's own booking refusals, translated to Appendix B in one place. Every code produced here
 * is in the contract's closed list. An error that matches nothing passes through as itself: it is
 * never turned into an invented 409, because Alfred refunds and releases the unit on a 4xx.
 */
const SLOT_GONE = new Set(["SLOT_UNAVAILABLE", "PROVIDER_NOT_ELIGIBLE", "SLOT_NOT_ALIGNED"]);

export function remapBookingError(error: unknown): unknown {
  const code = (error as { code?: unknown }).code;
  if (error instanceof ConflictError || error instanceof ValidationError) {
    if (typeof code === "string" && SLOT_GONE.has(code))
      return contractConflict("SLOT_TAKEN", "That time is no longer available");
    if (code === "MEMBER_DOUBLE_BOOKED")
      return contractConflict("ALREADY_BOOKED", "The member already has a booking at that time");
  }
  return error;
}
