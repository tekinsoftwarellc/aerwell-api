// Hand-maintained manifest for W5 members, memberships and billing; the
// swagger drift test compares it with the mounted Express routes.
const error = { $ref: "#/components/schemas/ErrorResponse" };
const errors = {
  400: { description: "VALIDATION_ERROR", content: { "application/json": { schema: error } } },
  401: { description: "Staff session required" },
  403: { description: "Missing module permission, or own-scope reassignment" },
  404: { description: "Not found in the organization or the actor's assigned-member scope" },
  409: {
    description:
      "MEMBER_EMAIL_EXISTS, MEMBER_ARCHIVED, MEMBERSHIP_OVERLAP, FLAG_ALREADY_RESOLVED, VERSION_CONFLICT",
  },
  422: {
    description:
      "PLAN_NOT_ASSIGNABLE, INVALID_MEMBERSHIP_TRANSITION, PAYMENT_METHOD_MISMATCH, UPLOAD_INCOMPLETE",
  },
  502: { description: "PAYMENT_FAILED (processor error; message never forwarded)" },
  503: { description: "PAYMENTS_UNCONFIGURED or STORAGE_UNAVAILABLE" },
};
type Spec = [method: string, path: string, summary: string, extra?: Record<string, unknown>];
const ops: Spec[] = [
  [
    "get",
    "/members",
    "List members (MEMBER_RECORDS view). q, status[], flags[] (on_waitlist|outstanding_balance|flagged_for_review), sort, page, limit. Audited.",
  ],
  [
    "post",
    "/members",
    "Create a clinical member record, pending_onboarding (MEMBER_RECORDS edit). No credentials are minted; optional memberships[]. Audited.",
  ],
  [
    "get",
    "/members/search",
    "Typeahead {items:[{_id,name,avatarUrl,brandLabel}], externalSearch:'unconfigured'} (MEMBER_RECORDS view). Audited.",
  ],
  [
    "post",
    "/members/bulk/archive",
    "Archive members, never delete (MEMBER_RECORDS master). All ids in scope or 404.",
  ],
  [
    "get",
    "/members/{id}",
    "Member profile with photoUrl, brandLabel, alfredLink, alfredMembership (the plan Alfred last reported; a record only, never entitlement) (MEMBER_RECORDS view). Audited.",
  ],
  [
    "patch",
    "/members/{id}",
    "Edit profile/status/assignment (MEMBER_RECORDS edit; assignment needs scope all). Audited.",
  ],
  [
    "get",
    "/members/{id}/overview",
    "Flags, notes preview (null without CLINICAL_NOTES view); visits, todayAppointment and appointments {todayCount, upcoming} (null without APPOINTMENTS view; own scope = own appointments); health/labs/dexa null (served by clinical routes). Audited.",
  ],
  [
    "get",
    "/members/{id}/flags",
    "Flags by state active|resolved|all (MEMBER_RECORDS view). Audited.",
  ],
  ["post", "/members/{id}/flags", "Raise a flag (MEMBER_RECORDS edit). Audited."],
  [
    "post",
    "/members/{id}/flags/{flagId}/resolve",
    "Resolve once; repeat is 409 FLAG_ALREADY_RESOLVED (MEMBER_RECORDS edit). Audited.",
  ],
  [
    "get",
    "/members/{id}/notes",
    "Notes with author and per-reader isNew/newCount (CLINICAL_NOTES view); ?appointmentId= limits to one visit. Audited.",
  ],
  [
    "post",
    "/members/{id}/notes",
    "Write a note (CLINICAL_NOTES edit); appointmentId (must be this member's) and recordingOffsetSec for visit notes. Audited.",
  ],
  [
    "post",
    "/members/{id}/notes/read",
    "Mark noteIds (or all) read for the actor, idempotent (CLINICAL_NOTES view). Audited.",
  ],
  [
    "get",
    "/members/{id}/memberships",
    "Membership records (overlap allowed) + clinicianChatAllowed (MEMBER_RECORDS view). Audited.",
  ],
  [
    "post",
    "/members/{id}/memberships",
    "Hold a plan: startedAt is the anniversary anchor; same-plan overlap is 409 (MEMBER_RECORDS edit). Audited.",
  ],
  [
    "patch",
    "/members/{id}/memberships/{membershipId}",
    "Status/endsAt/autoRenew with optional expectedVersion (MEMBER_RECORDS edit). Audited.",
  ],
  [
    "get",
    "/members/{id}/benefits",
    "Benefits per current membership: used is 0 and usage.tracked=false until the W6 ledger; renewsAt from the anniversary period. Audited.",
  ],
  [
    "get",
    "/billing/config",
    "{configured, publishableKey}; configured=false without Stripe keys (BILLING view).",
  ],
  ["get", "/members/{id}/payment-method", "Card display fields only (BILLING view). Audited."],
  [
    "put",
    "/members/{id}/payment-method",
    "Store a Stripe pm_ id attached by the SetupIntent; 503 PAYMENTS_UNCONFIGURED without keys (BILLING edit). Audited.",
  ],
  [
    "post",
    "/members/{id}/payment-method/setup-intent",
    "SetupIntent client secret for Stripe Elements; 503 PAYMENTS_UNCONFIGURED without keys (BILLING edit).",
  ],
  [
    "get",
    "/members/{id}/invoices",
    "Invoices written from verified webhooks, newest first (BILLING view). Audited.",
  ],
  [
    "get",
    "/invoices/{id}/pdf",
    "Processor-hosted invoice URL (BILLING view, member scope). Audited.",
  ],
  [
    "get",
    "/me/view-preferences/{context}",
    "Customize View layout for the signed-in staff member (default when unset).",
  ],
  [
    "put",
    "/me/view-preferences/{context}",
    "Save layout 1|2|3 with one card list per column; a card appears once.",
  ],
  [
    "post",
    "/webhooks/stripe",
    "Stripe webhook: raw body, Stripe-Signature HMAC verified (300 s tolerance), idempotent per event id. 400 INVALID_SIGNATURE; 503 PAYMENTS_UNCONFIGURED without a webhook secret.",
    { security: [] },
  ],
];
const params = (path: string) =>
  [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
    name: match[1],
    in: "path",
    required: true,
    schema:
      match[1] === "context"
        ? { type: "string", enum: ["member_profile", "member_appointment"] }
        : { type: "string", pattern: "^[a-f0-9]{24}$" },
  }));
export const memberPaths: Record<string, Record<string, unknown>> = {};
for (const [method, path, summary, extra] of ops) {
  const key = `/api/v1${path}`;
  memberPaths[key] = {
    ...memberPaths[key],
    [method]: {
      summary,
      tags: ["Members and billing"],
      security: [{ staffBearer: [] }],
      parameters: params(path),
      responses: {
        200: { description: "Success envelope" },
        201: { description: "Created" },
        ...errors,
      },
      ...extra,
    },
  };
}
