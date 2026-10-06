import { AppError, ConflictError } from "../../common/errors/AppError.js";

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
