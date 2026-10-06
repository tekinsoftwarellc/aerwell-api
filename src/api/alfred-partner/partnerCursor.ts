import { Types } from "mongoose";
import { BadRequestError } from "../../common/errors/AppError.js";

/**
 * Opaque keyset cursor `base64url("<updatedAt ms>:<id>")` for the sync streams (contract §4.2).
 * A malformed cursor is a 400, never a silent restart from page 1: a puller looping until
 * `nextCursor` is null would otherwise never finish.
 */
export interface Cursor {
  updatedAt: Date;
  id: string;
}

export const encodeCursor = (updatedAt: Date, id: string): string =>
  Buffer.from(`${updatedAt.getTime()}:${id}`).toString("base64url");

export function decodeCursor(cursor: string): Cursor {
  const [millis, id, extra] = Buffer.from(cursor, "base64url").toString("utf8").split(":");
  const time = Number(millis);
  if (extra !== undefined || !Number.isFinite(time) || !id || !Types.ObjectId.isValid(id))
    throw new BadRequestError("Malformed cursor");
  return { updatedAt: new Date(time), id };
}

/** Strictly after `(updatedAt, _id)`; the sort must be `{ updatedAt: 1, _id: 1 }` for ties. */
export const afterKeyset = (cursor: Cursor) => ({
  $or: [
    { updatedAt: { $gt: cursor.updatedAt } },
    { updatedAt: cursor.updatedAt, _id: { $gt: new Types.ObjectId(cursor.id) } },
  ],
});
