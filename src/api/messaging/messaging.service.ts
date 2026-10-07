import type { Request } from "express";
import { AppError, NotFoundError } from "../../common/errors/AppError.js";
import { actor } from "../../common/http.js";
import {
  AlfredMessagingError,
  AlfredMessagingUnavailableError,
  type AlfredPartnerThread,
  type PartnerActor,
  alfredPartnerMessagingClient as alfred,
} from "../../common/services/alfredPartnerMessagingClient.js";
import { audit } from "../audit/audit.js";
import { Member } from "../member/member.model.js";
import { memberScope } from "../member/member.scope.js";
import { Role } from "../role/role.model.js";

/** Pass-through only: thread and message ids and bodies are Alfred's and are never stored here. */
const PAGE = 100;
// ponytail: at most 1000 threads are read per call; page Alfred by member if a clinic outgrows that.
const MAX_PAGES = 10;

/** Alfred down or misconfigured is our 503; its refusals keep their status and code only. */
export async function viaAlfred<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AlfredMessagingUnavailableError)
      throw new AppError(
        "Messaging is unavailable right now",
        503,
        true,
        undefined,
        "ALFRED_UNAVAILABLE"
      );
    if (error instanceof AlfredMessagingError)
      throw new AppError(error.message, error.status, true, undefined, error.code);
    throw error;
  }
}

/** Every thread of the partner, newest activity first. */
export async function fetchAllThreads(): Promise<AlfredPartnerThread[]> {
  const out: AlfredPartnerThread[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const result = await alfred.listThreads({ page, limit: PAGE });
    out.push(...result.items);
    if (page >= result.totalPages) break;
  }
  return out.sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
}

/** Threads whose member is inside the actor's scope, each with its Aerwell member. */
async function scopedThreads(req: Request) {
  const threads = await fetchAllThreads();
  const members = await Member.find({
    ...(await memberScope(req)),
    alfredAccountId: { $in: [...new Set(threads.map((t) => t.accountId))] },
  })
    .select("firstName lastName alfredAccountId")
    .lean();
  const byAccount = new Map(members.map((m) => [m.alfredAccountId, m]));
  return threads.flatMap((thread) => {
    const member = byAccount.get(thread.accountId);
    return member ? [{ thread, member }] : [];
  });
}

export async function listThreads(
  req: Request,
  query: { unreadOnly: "true" | "false"; page: number; limit: number }
) {
  const rows = await viaAlfred(() => scopedThreads(req));
  const wanted =
    query.unreadOnly === "true" ? rows.filter((r) => r.thread.unreadForStaff > 0) : rows;
  const items = wanted
    .slice((query.page - 1) * query.limit, query.page * query.limit)
    .map(({ thread, member }) => ({
      id: thread.id,
      memberId: String(member._id),
      memberName: `${member.firstName} ${member.lastName}`.trim(),
      lastMessagePreview: thread.lastMessagePreview ?? null,
      lastMessageAt: thread.lastMessageAt,
      unreadForStaff: thread.unreadForStaff,
      createdAt: thread.createdAt,
    }));
  return {
    items,
    total: wanted.length,
    page: query.page,
    limit: query.limit,
    totalPages: Math.max(1, Math.ceil(wanted.length / query.limit)),
  };
}

export async function unreadCount(req: Request) {
  const unread = (await viaAlfred(() => scopedThreads(req))).filter(
    (r) => r.thread.unreadForStaff > 0
  );
  return {
    unreadThreads: unread.length,
    unreadMessages: unread.reduce((sum, r) => sum + r.thread.unreadForStaff, 0),
  };
}

/** The staff member as Alfred knows them: id, display name and role name, never an avatar. */
export async function actorFor(req: Request): Promise<PartnerActor> {
  const staff = actor(req);
  const role = staff.roleId ? await Role.findById(staff.roleId).select("name").lean() : null;
  return {
    staffRef: String(staff._id),
    name: `${staff.firstName} ${staff.lastName}`.trim().slice(0, 120) || "Clinician",
    role: (role?.name ?? "Clinician").slice(0, 60),
  };
}

/**
 * A thread is reachable only through a member the actor may see, and only if Alfred lists it
 * under that member's account: an id from elsewhere is a 404, never someone else's thread.
 */
async function threadOf(req: Request, memberId: string, threadId: string) {
  const member = await Member.findOne({ _id: memberId, ...(await memberScope(req)) })
    .select("alfredAccountId")
    .lean();
  const accountId = member?.alfredAccountId;
  if (!accountId) throw new NotFoundError("Thread not found");
  const { items } = await viaAlfred(() => alfred.listThreads({ accountId, limit: PAGE }));
  if (!items.some((t) => t.id === threadId)) throw new NotFoundError("Thread not found");
}

export async function listMessages(
  req: Request,
  threadId: string,
  query: { memberId: string; page: number; limit: number }
) {
  await threadOf(req, query.memberId, threadId);
  const page = await viaAlfred(() => alfred.listMessages(threadId, query));
  await audit(req, "viewed", "MessageThread", threadId, query.memberId);
  return page;
}

export async function sendMessage(
  req: Request,
  threadId: string,
  input: { memberId: string; body: string }
) {
  await threadOf(req, input.memberId, threadId);
  const message = await viaAlfred(async () =>
    alfred.sendMessage(threadId, { actor: await actorFor(req), body: input.body })
  );
  // Ids only: the body never reaches the audit trail.
  await audit(req, "created", "Message", message.id, input.memberId);
  return message;
}

export async function markRead(req: Request, threadId: string, input: { memberId: string }) {
  await threadOf(req, input.memberId, threadId);
  return viaAlfred(async () => alfred.markRead(threadId, { actor: await actorFor(req) }));
}
