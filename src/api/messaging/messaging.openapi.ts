// Hand-maintained; the swagger drift test compares it with the mounted routes.
const error = { $ref: "#/components/schemas/ErrorResponse" };
const responses = {
  200: { description: "Success envelope" },
  201: { description: "Created" },
  400: { description: "Validation failed", content: { "application/json": { schema: error } } },
  401: { description: "Staff session required" },
  403: { description: "Missing MEMBER_RECORDS level" },
  404: { description: "Thread or member not found in the organization or the actor's own scope" },
  503: {
    description:
      "ALFRED_UNAVAILABLE: Alfred unreachable, unconfigured, or refused our credentials. Alfred's text is never forwarded.",
  },
};
const threadId = { name: "threadId", in: "path", required: true, schema: { type: "string" } };
const memberId = { name: "memberId", in: "query", required: true, schema: { type: "string" } };
const op = (summary: string, parameters: unknown[] = []) => ({
  summary,
  tags: ["Messaging"],
  security: [{ staffBearer: [] }],
  parameters,
  responses,
});
export const messagingPaths = {
  "/api/v1/messaging/threads": {
    get: op(
      "Shared clinic inbox threads of members in the actor's scope, newest first, with member name and unread count (MEMBER_RECORDS view). Pass-through: nothing is stored here.",
      ["unreadOnly", "page", "limit"].map((name) => ({
        name,
        in: "query",
        schema: { type: "string" },
      }))
    ),
  },
  "/api/v1/messaging/unread-count": {
    get: op("{unreadThreads, unreadMessages} for the actor's scope (MEMBER_RECORDS view)."),
  },
  "/api/v1/messaging/threads/{threadId}/messages": {
    get: op("Messages of one thread, newest first (MEMBER_RECORDS view). Audited, ids only.", [
      threadId,
      memberId,
      ...["page", "limit"].map((name) => ({ name, in: "query", schema: { type: "string" } })),
    ]),
    post: op(
      "Reply as the signed-in staff member: {memberId, body (1-2000)}; no attachments (MEMBER_RECORDS edit). Audited, ids only.",
      [threadId]
    ),
  },
  "/api/v1/messaging/threads/{threadId}/read": {
    post: op("Mark a thread read for staff: {memberId} (MEMBER_RECORDS edit).", [threadId]),
  },
};
