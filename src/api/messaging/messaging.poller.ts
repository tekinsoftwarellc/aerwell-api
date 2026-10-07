import { logger } from "../../common/utils/logger.js";
import { env } from "../../config/env.js";
import { Member } from "../member/member.model.js";
import { memberMessage } from "../notification/producers.js";
import { fetchAllThreads } from "./messaging.service.js";

const POLL_MS = 60_000;

/**
 * Alfred cannot push a member message to the partner, so unread threads are polled and each
 * new one raises one generic staff notice. The dedupe key is thread + last-message time: a
 * rerun, a restart or a second poll of the same message writes nothing. No content is read.
 */
export async function pollMemberMessages(organizationId: string): Promise<number> {
  const unread = (await fetchAllThreads()).filter((t) => t.unreadForStaff > 0 && t.lastMessageAt);
  if (!unread.length) return 0;
  const members = await Member.find({
    organizationId,
    alfredAccountId: { $in: unread.map((t) => t.accountId) },
  })
    .select("alfredAccountId")
    .lean();
  const byAccount = new Map(members.map((m) => [m.alfredAccountId, m._id]));
  let raised = 0;
  for (const thread of unread) {
    const memberId = byAccount.get(thread.accountId);
    if (!memberId) continue;
    await memberMessage({
      organizationId,
      memberId,
      dedupeKey: `msg:${thread.id}:${thread.lastMessageAt}`,
    });
    raised += 1;
  }
  return raised;
}

/** Off until Alfred's address and credentials exist; one run at a time. */
export function startMessagePoller(organizationId: string | undefined): NodeJS.Timeout | undefined {
  if (!(organizationId && env.ALFRED_API_URL && env.ALFRED_AUTH_URL && env.ALFRED_AUTH_CLIENT_ID))
    return undefined;
  let running = false;
  return setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await pollMemberMessages(organizationId);
    } catch (error) {
      logger.warn({ error: (error as Error).name }, "Message poll failed");
    } finally {
      running = false;
    }
  }, POLL_MS).unref();
}
