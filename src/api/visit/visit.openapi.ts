// Hand-maintained manifest for the W9 visit workspace; the swagger drift test
// compares it with the mounted Express routes. The live-audio WebSocket is not
// an Express route and is described on GET /appointments/{id}/visit.
const error = { $ref: "#/components/schemas/ErrorResponse" };
const errors = {
  400: { description: "VALIDATION_ERROR", content: { "application/json": { schema: error } } },
  401: { description: "Staff session required" },
  403: { description: "Missing APPOINTMENTS permission; CLINICAL_NOTES_REQUIRED (view or edit)" },
  404: {
    description:
      "Not found in the organization or the actor's APPOINTMENTS / MEMBER_RECORDS / CLINICAL_NOTES scope; SUGGESTION_NOT_FOUND",
  },
  409: {
    description: "CONSENT_ALREADY_RECORDED, NO_ACTIVE_CONSENT, SUGGESTIONS_EXIST, ALREADY_DECIDED",
  },
  422: {
    description: "VISIT_NOT_ACTIVE, VISIT_NOT_STARTED, CONSENT_VERSION_STALE, TRANSCRIPT_EMPTY",
  },
};
type Spec = [method: string, path: string, summary: string, extra?: Record<string, unknown>];
const ops: Spec[] = [
  [
    "get",
    "/appointments/{id}/visit",
    "Visit workspace state: status, startedAt/endedAt/durationSec (visit starts at PATCH status in_progress, ends at completed), summary, active consent, current consent text {version,text}, capture.active, segmentCount, transcription.configured, suggestions.configured. Live audio: WebSocket /ws/appointments/{id}/transcription, subprotocols [aerwell.v1, bearer.<accessToken>], APPOINTMENTS edit + CLINICAL_NOTES edit; refused before the handshake with 401/403/404. Messages: start | stop | reauth{token}; binary 16 kHz mono s16le PCM (<=32000 bytes, even); server ready | started | transcript | stopped | error{code} (CONSENT_REQUIRED, CONSENT_REVOKED, TRANSCRIPTION_UNCONFIGURED, CAPTURE_IN_PROGRESS, VISIT_NOT_IN_PROGRESS, VISIT_ENDED, SESSION_EXPIRED, SESSION_REVOKED, AUDIO_BACKLOG, CLIENT_BACKLOG, HEARTBEAT_TIMEOUT). Audio is never stored. Audited.",
  ],
  ["patch", "/appointments/{id}/visit", "Edit the visit summary (CLINICAL_NOTES edit). Audited."],
  [
    "post",
    "/appointments/{id}/visit/consent",
    "Record the member's consent to transcription {method verbal|written, consentVersion} before any audio capture; stores who, when, method and a snapshot of the versioned consent text. Checked-in or in-progress visits only. Audited.",
  ],
  [
    "post",
    "/appointments/{id}/visit/consent/revoke",
    "Revoke the active consent; any live capture stops immediately. Audited.",
  ],
  [
    "get",
    "/appointments/{id}/transcript",
    "Persisted transcript segments ordered by capture then sequence; speakers are 'Speaker N' by first appearance (never a role). retention: transcript_only. CLINICAL_NOTES view. Audited.",
  ],
  [
    "get",
    "/appointments/{id}/next-steps",
    "Draft next steps with status draft|accepted|rejected. CLINICAL_NOTES view. Audited.",
  ],
  [
    "post",
    "/appointments/{id}/next-steps",
    "Draft next steps once from the transcript with Bedrock (us. inference profile, BEDROCK_MODEL_FAST); invalid or ungrounded items are dropped; server-assigned ids; nothing is written to the record. 503 SUGGESTIONS_UNCONFIGURED; 502 SUGGESTIONS_FAILED. CLINICAL_NOTES edit. Audited.",
    {
      responses: {
        502: { description: "SUGGESTIONS_FAILED" },
        503: { description: "SUGGESTIONS_UNCONFIGURED" },
      },
    },
  ],
  [
    "post",
    "/appointments/{id}/next-steps/{sid}/decision",
    "Accept (optionally with an edited title/detail) or reject one draft, once. Records the decision only. CLINICAL_NOTES edit. Audited.",
  ],
];
const params = (path: string) =>
  [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
    name: match[1],
    in: "path",
    required: true,
    schema: { type: "string", pattern: "^[a-f0-9]{24}$" },
  }));
export const visitPaths: Record<string, Record<string, unknown>> = {};
for (const [method, path, summary, extra] of ops) {
  const key = `/api/v1${path}`;
  visitPaths[key] = {
    ...visitPaths[key],
    [method]: {
      summary,
      tags: ["Visits"],
      security: [{ staffBearer: [] }],
      parameters: params(path),
      responses: {
        200: { description: "Success envelope" },
        201: { description: "Created" },
        ...errors,
        ...(extra?.["responses"] as object),
      },
    },
  };
}
