// Hand-maintained manifest for Alfred AI (W10); the swagger drift test compares it
// with the mounted Express routes.
const errors = {
  400: { description: "VALIDATION_ERROR" },
  401: { description: "Staff session required" },
  404: {
    description:
      "CONVERSATION_NOT_FOUND, DRAFT_NOT_FOUND, SUGGESTION_NOT_FOUND, or the member/appointment is outside the actor's scope",
  },
  409: {
    description:
      "DRAFT_DECIDED, ALREADY_DECIDED, or the target route's own conflict codes on confirm",
  },
  429: { description: "AI_RATE_LIMITED (per staff member)" },
  502: {
    description: "AI_FAILED (model call failed; provider error name is logged, never the message)",
  },
  503: { description: "AI_UNCONFIGURED (no BEDROCK_REGION or model id for the tier)" },
};
type Spec = [method: string, path: string, summary: string];
const ops: Spec[] = [
  [
    "get",
    "/alfred/config",
    "Whether chat (BEDROCK_MODEL_SMART) and suggestions (BEDROCK_MODEL_FAST) are configured.",
  ],
  ["get", "/alfred/conversations", "The caller's own conversations, newest first (max 30)."],
  ["post", "/alfred/conversations", "Start a conversation owned by the caller."],
  [
    "get",
    "/alfred/conversations/{id}/messages",
    "Visible history only: user and assistant text plus server draft cards. Tool calls and raw tool results are never stored or returned.",
  ],
  [
    "post",
    "/alfred/conversations/{id}/messages",
    "Send {text}. Alfred answers with read tools that call the mounted routes as the caller (same permissions, own scope and audit) and may propose drafts. Returns the new user and assistant messages.",
  ],
  [
    "get",
    "/alfred/drafts/{draftId}",
    "One of the caller's drafts: kind, status, server preview, editable text fields.",
  ],
  [
    "post",
    "/alfred/drafts/{draftId}/confirm",
    "Confirm a pending draft, optionally with {edits} to its editable text fields. Runs the target route (guard, schema, handler, audit) as the caller; a booking carries a server idempotency key and the quoted price.",
  ],
  ["post", "/alfred/drafts/{draftId}/cancel", "Cancel a pending draft. Nothing is written."],
  [
    "get",
    "/alfred/suggestions",
    "Latest suggestion batch for ?context=member_overview&memberId | visit&appointmentId | dashboard: items (not dismissed), done, total, configured. Audited for member contexts.",
  ],
  [
    "post",
    "/alfred/suggestions",
    "Generate suggestions {context, memberId?, appointmentId?} from the routes the caller can read. Drafts only; nothing is written to the record.",
  ],
  ["post", "/alfred/suggestions/{sid}/action", "Mark a suggestion {status: done|dismissed}, once."],
];
const params = (path: string) =>
  [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({
    name: m[1],
    in: "path",
    required: true,
    schema: { type: "string", pattern: "^[a-f0-9]{24}$" },
  }));
export const alfredPaths: Record<string, Record<string, unknown>> = {};
for (const [method, path, summary] of ops) {
  const key = `/api/v1${path}`;
  alfredPaths[key] = {
    ...alfredPaths[key],
    [method]: {
      summary,
      tags: ["Alfred AI"],
      security: [{ staffBearer: [] }],
      parameters: params(path),
      responses: {
        200: { description: "Success envelope" },
        201: { description: "Created" },
        ...errors,
      },
    },
  };
}
