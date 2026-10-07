import { env } from "../../config/env.js";
import { logger } from "../utils/logger.js";
import { ServiceTokenUnavailableError, getServiceToken } from "./serviceTokenClient.js";

/**
 * Aerwell -> Alfred, the five partner-staff messaging routes of contract §6.4.
 * Scope `partner.messaging.staff`; the acting staff member travels in the BODY as `actor`.
 *
 * NOTHING about a request or response is logged: bodies are PHI and the headers hold a bearer.
 * Only a code, the path and an error's class name ever reach the log.
 */
const SCOPE = "partner.messaging.staff";
const TIMEOUT_MS = 3_000;

/** Alfred could not be reached, configured or trusted (incl. its 401/403). Callers answer 503. */
export class AlfredMessagingUnavailableError extends Error {
  constructor(public readonly reason: string) {
    super("Alfred messaging is unavailable");
    this.name = "AlfredMessagingUnavailableError";
  }
}

/** Alfred ANSWERED with a refusal (400/404/409/422/429). Status and `data.code` are relayed. */
export class AlfredMessagingError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined
  ) {
    super("Alfred refused the request");
    this.name = "AlfredMessagingError";
  }
}

export interface PartnerActor {
  readonly staffRef: string;
  readonly name: string;
  readonly role: string;
}
export interface AlfredPartnerThread {
  readonly id: string;
  readonly accountId: string;
  readonly staff: { readonly ref: string; readonly name: string; readonly role: string };
  readonly lastMessagePreview?: string;
  readonly lastMessageAt: string | null;
  readonly unreadForMember: number;
  readonly unreadForStaff: number;
  readonly createdAt: string;
}
export interface AlfredMessage {
  readonly id: string;
  readonly threadId: string;
  readonly sender: "member" | "staff" | "alfred";
  readonly staffRef?: string;
  readonly body: string;
  readonly attachments: readonly {
    name: string;
    mimeType: string;
    sizeBytes: number;
    url?: string;
  }[];
  readonly sentAt: string;
  readonly readAt: string | null;
}
export interface AlfredPage<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly page: number;
  readonly limit: number;
  readonly totalPages: number;
}

const unavailable = (reason: string, path: string): never => {
  logger.warn({ code: "ALFRED_UNAVAILABLE", path, reason }, "alfred messaging unavailable");
  throw new AlfredMessagingUnavailableError(reason);
};

const attempt = (method: "GET" | "POST", path: string, body: unknown, token: string) =>
  fetch(`${env.ALFRED_API_URL}/api/v1/partner/messaging${path}`, {
    method,
    headers: {
      // biome-ignore lint/style/useNamingConvention: an HTTP header name.
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-contract-version": "1",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

/** One call. GETs retry once on a transport failure or 5xx; POSTs never (a send is not idempotent). */
async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  if (!env.ALFRED_API_URL) return unavailable("no-base-url", path);
  let token: string;
  try {
    token = await getServiceToken("alfred-api", SCOPE);
  } catch (error) {
    return unavailable(
      error instanceof ServiceTokenUnavailableError ? "token" : "token-error",
      path
    );
  }
  const retries = method === "GET" ? 1 : 0;
  let res: Response | undefined;
  for (let tries = 0; tries <= retries; tries += 1) {
    try {
      res = await attempt(method, path, body, token);
    } catch {
      if (tries === retries) return unavailable("unreachable", path);
      continue;
    }
    if (res.status >= 500 && tries < retries) continue;
    break;
  }
  // 5xx: Alfred failing. 401/403: our credentials or capability are wrong, which is ours to fix.
  if (!res || res.status >= 500 || res.status === 401 || res.status === 403)
    return unavailable(`status-${res?.status ?? 0}`, path);
  let envelope: { data?: unknown } = {};
  try {
    envelope = (await res.json()) as { data?: unknown };
  } catch {
    if (res.ok) return unavailable("unreadable-body", path);
  }
  if (!res.ok) {
    const data = envelope.data as { code?: unknown } | undefined;
    throw new AlfredMessagingError(
      res.status,
      typeof data?.code === "string" ? data.code : undefined
    );
  }
  return envelope.data as T;
}

const pageQuery = (input: Record<string, string | number | undefined>) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input))
    if (value !== undefined && value !== "") query.set(key, String(value));
  return query.size ? `?${query}` : "";
};

export const alfredPartnerMessagingClient = {
  /** `POST /threads`, idempotent on accountId + actor.staffRef. */
  createThread: (input: { accountId: string; actor: PartnerActor }) =>
    call<AlfredPartnerThread>("POST", "/threads", input),
  /** `GET /threads`; an omitted `staffRef` means every staff member of the partner. */
  listThreads: (input: { accountId?: string; page?: number; limit?: number } = {}) =>
    call<AlfredPage<AlfredPartnerThread>>("GET", `/threads${pageQuery(input)}`),
  /** `GET /threads/{id}/messages`, newest first. */
  listMessages: (threadId: string, input: { page?: number; limit?: number } = {}) =>
    call<AlfredPage<AlfredMessage>>(
      "GET",
      `/threads/${encodeURIComponent(threadId)}/messages${pageQuery(input)}`
    ),
  /** `POST /threads/{id}/messages`. `attachments` is omitted: v1 sends none. */
  sendMessage: (
    threadId: string,
    input: { actor: PartnerActor; body: string; messageRef?: string }
  ) => call<AlfredMessage>("POST", `/threads/${encodeURIComponent(threadId)}/messages`, input),
  /** `POST /threads/{id}/read`. */
  markRead: (threadId: string, input: { actor: PartnerActor }) =>
    call<{ threadId: string; unreadForStaff: number }>(
      "POST",
      `/threads/${encodeURIComponent(threadId)}/read`,
      input
    ),
};
