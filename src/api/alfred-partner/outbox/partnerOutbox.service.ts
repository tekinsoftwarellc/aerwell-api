import { createHash } from "node:crypto";
import type { ClientSession } from "mongoose";
import { logger } from "../../../common/utils/logger.js";
import { env } from "../../../config/env.js";
import { Member } from "../../member/member.model.js";
import { PartnerOutbox } from "./partnerOutbox.model.js";

export interface OutboxEvent {
  type: string;
  occurredAt: Date;
  /** Present for member-scoped events; absent for catalog events. */
  accountId?: string;
  resource: { kind: string; ref: string };
  payload: Record<string, unknown>;
}
const KEY_MAX = 128;

/** `type:ref:occurredAtMs`; one over 128 characters becomes `type:h:<sha256-32>`, written once. */
export function eventKey(event: OutboxEvent): string {
  const key = `${event.type}:${event.resource.ref}:${event.occurredAt.getTime()}`;
  if (key.length <= KEY_MAX) return key;
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return `${event.type}:h:${hash}`;
}

/**
 * Write one row. An upsert on the key, so a repeat is a no-op and never a duplicate-key error (which
 * would abort the surrounding transaction). Pass the session to commit the row with the change.
 */
export async function enqueue(event: OutboxEvent, session?: ClientSession | null) {
  const organizationId = env.AERWELL_ORG_ID;
  if (!organizationId) return;
  const idempotencyKey = eventKey(event);
  await PartnerOutbox.updateOne(
    { organizationId, idempotencyKey },
    {
      $setOnInsert: {
        organizationId,
        idempotencyKey,
        type: event.type,
        occurredAt: event.occurredAt,
        ...(event.accountId ? { accountId: event.accountId } : {}),
        resource: event.resource,
        payload: event.payload,
        status: "pending",
        attempts: 0,
        nextAttemptAt: new Date(),
      },
    },
    { upsert: true, ...(session ? { session } : {}) }
  );
}

/** The Alfred account a member is linked to, or null: a member Alfred does not know produces no event. */
export async function linkedAccount(memberId: unknown, session?: ClientSession | null) {
  const member = await Member.findOne({
    _id: memberId,
    alfredAccountId: { $type: "string" },
    alfredUnlinkedAt: null,
  })
    .select("alfredAccountId")
    .session(session ?? null)
    .lean();
  return member?.alfredAccountId ?? null;
}

/**
 * Enqueue an event about a member's booking, if that member is linked to Alfred. The payload is built
 * outside the write so a mapping bug is logged and skipped rather than blocking the staff change
 * (a failed write inside a transaction would abort it; a failed read does not).
 */
export async function enqueueForMember(
  memberId: unknown,
  build: (accountId: string) => Promise<OutboxEvent>,
  session?: ClientSession | null
) {
  const accountId = await linkedAccount(memberId, session);
  if (!accountId) return;
  let event: OutboxEvent;
  try {
    event = await build(accountId);
  } catch (error) {
    logger.error({ errorType: (error as Error).name }, "outbox payload could not be built");
    return;
  }
  await enqueue(event, session);
}

/** After-commit variant for changes that are not in a transaction: never throws. */
export async function enqueueSafely(event: OutboxEvent) {
  try {
    await enqueue(event);
  } catch (error) {
    logger.error({ errorType: (error as Error).name }, "outbox enqueue failed");
  }
}
