import type { Request } from "express";
import mongoose, { type ClientSession } from "mongoose";
import { ConflictError } from "../../common/errors/AppError.js";
import { audit } from "../audit/audit.js";
import { CatalogRevision } from "./catalog.model.js";

export type CatalogEntity = "service" | "market" | "membership_plan" | "delivery_modifier";
/** What the versioning helpers use of a catalog document (catalog models version with `version`). */
export interface CatalogDoc {
  _id: unknown;
  toObject(options?: { depopulate?: boolean }): Record<string, unknown>;
  save(options?: { session?: ClientSession }): Promise<unknown>;
}
type VersionedDoc = CatalogDoc & { version?: number };
const conflict = () =>
  new ConflictError(
    "This record changed since you opened it. Reload and try again.",
    undefined,
    "VERSION_CONFLICT"
  );

export function assertExpectedVersion(doc: VersionedDoc, expected: number | undefined) {
  if (expected !== undefined && expected !== doc.version) throw conflict();
}

function revision(req: Request, entityType: CatalogEntity, doc: VersionedDoc) {
  const { __v, ...snapshot } = doc.toObject({ depopulate: true });
  return {
    organizationId: req.staff?.organizationId,
    entityType,
    entityId: String(doc._id),
    version: doc.version ?? 0,
    snapshot,
    actorId: String(req.staff?._id),
    effectiveFrom: new Date(),
  };
}

export async function inCatalogTransaction<T>(work: (session: ClientSession) => Promise<T>) {
  const session = await mongoose.startSession();
  try {
    let result: T | undefined;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result as T;
  } catch (error) {
    if (error instanceof Error && error.name === "VersionError") throw conflict();
    throw error;
  } finally {
    await session.endSession();
  }
}

/** Save + append-only revision + audit event, atomically. */
export function saveVersioned(
  req: Request,
  entityType: CatalogEntity,
  doc: VersionedDoc,
  action: string
) {
  return inCatalogTransaction(async (session) => {
    await doc.save({ session });
    await recordRevisions(req, entityType, [doc], action, session);
  });
}

export async function recordRevisions(
  req: Request,
  entityType: CatalogEntity,
  docs: VersionedDoc[],
  action: string,
  session: ClientSession
) {
  await CatalogRevision.create(
    docs.map((doc) => revision(req, entityType, doc)),
    { session, ordered: true }
  );
  for (const doc of docs) await audit(req, action, entityType, String(doc._id), undefined, session);
}
