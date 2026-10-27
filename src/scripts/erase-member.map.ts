// Erasure classification for every collection that can hold a member's rows (decision 4A,
// signed 27 Oct 2026: manual scripts, keep audit + payment/tax). `erase-member.test.ts` fails
// when a model that carries a LINK_FIELDS path is missing here, so a new member-linked model
// cannot ship unclassified.
//
// Raw driver collections are used on purpose: the append-only mongoose hooks (protocol
// history, audit) must not be able to block an erasure, and an erasure must not trip them.
//
// `keep:clinical` is Aerwell-specific. Aerwell is a clinic and Nevada NRS 629.051 requires
// providers to keep health-care records for five years, which conflicts with the signed
// keep-list that erased clinical rows. Counsel has not ruled, so clinical rows are KEPT and
// MARKED retained (reversible); erasing them later is a one-line change. See the runbook.
export type ErasureClass =
  | "erase"
  | "pseudonymise"
  | "keep:audit"
  | "keep:payment"
  | "keep:clinical"
  | "notMember";

export interface ErasureEntry {
  class: ErasureClass;
  collection: string;
  /** Link paths: `alfredAccountId` matches the Alfred id, the rest the member ids. */
  by: string[];
  reason?: string;
  /** keep:payment rows stay, but this PII/free-text field is cleared (`$unset`, or set to `to`). */
  scrub?: { path: string; to?: Record<string, never> };
}

export const LINK_FIELDS = ["memberId", "alfredAccountId", "accountId"] as const;

const own = (collection: string): ErasureEntry => ({
  class: "erase",
  collection,
  by: ["memberId"],
});
const keep = (
  cls: "keep:audit" | "keep:payment" | "keep:clinical",
  collection: string,
  extra: Partial<ErasureEntry> = {}
): ErasureEntry => ({ class: cls, collection, by: ["memberId"], ...extra });
const notMember = (collection: string, reason: string): ErasureEntry => ({
  class: "notMember",
  collection,
  by: [],
  reason,
});

const STAFF_CHAT = "keyed by staffId, no member link; text may quote a member (runbook residual)";

const ENTRIES: readonly (readonly [string, ErasureEntry])[] = [
  // ── erase: staff AI scratch about the member, and local card references ──
  ["AlfredDraft", own("alfreddrafts")],
  ["AlfredSuggestion", own("alfredsuggestions")],
  // The processor customer and its payment methods stay at the processor.
  ["PaymentMethod", own("paymentmethods")],
  // ── pseudonymise (or retain, when clinical rows exist; see erase-member.ts) ──
  ["Member", { class: "pseudonymise", collection: "members", by: ["alfredAccountId"] }],
  // ── keep:audit ──
  ["AuditEvent", keep("keep:audit", "auditevents")],
  ["VisitConsent", keep("keep:audit", "visitconsents")],
  // ── keep:clinical (NRS 629.051, counsel question open) ──
  ["Appointment", keep("keep:clinical", "appointments")],
  ["LabPanel", keep("keep:clinical", "labpanels")],
  ["Scan", keep("keep:clinical", "scans")],
  ["HealthScoreSnapshot", keep("keep:clinical", "healthscoresnapshots")],
  ["ClinicalList", keep("keep:clinical", "clinicallists")],
  ["MemberNote", keep("keep:clinical", "membernotes")],
  ["MemberFlag", keep("keep:clinical", "memberflags")],
  ["Protocol", keep("keep:clinical", "protocols")],
  ["ProtocolRevision", keep("keep:clinical", "protocolrevisions")],
  ["InjectionLog", keep("keep:clinical", "injectionlogs")],
  ["TranscriptSegment", keep("keep:clinical", "transcriptsegments")],
  ["VisitSuggestion", keep("keep:clinical", "visitsuggestions")],
  // ── keep:payment ──
  ["MemberMembership", keep("keep:payment", "membermemberships")],
  ["AllowanceLedgerEntry", keep("keep:payment", "allowanceledgerentries")],
  ["Invoice", keep("keep:payment", "invoices")],
  ["AssessmentEpisode", keep("keep:payment", "assessmentepisodes")],
  [
    "SupplementOrder",
    keep("keep:payment", "supplementorders", { scrub: { path: "noteToMember" } }),
  ],
  [
    "ProductOrder",
    keep("keep:payment", "productorders", {
      by: ["memberId", "accountId"],
      scrub: { path: "shippingAddress" },
    }),
  ],
  // Delivered rows stay; pending rows are a blocker. payload can carry names, so it is emptied.
  [
    "PartnerOutbox",
    keep("keep:payment", "partner_outbox", {
      by: ["accountId"],
      scrub: { path: "payload", to: {} },
    }),
  ],
  // ── notMember ──
  ["AlfredConversation", notMember("alfredconversations", STAFF_CHAT)],
  ["AlfredMessage", notMember("alfredmessages", STAFF_CHAT)],
  ["AlfredUsage", notMember("alfredusages", STAFF_CHAT)],
  ["Notification", notMember("notifications", "recipientStaffId: staff notifications")],
  ["NotificationPreference", notMember("notificationpreferences", "staff preferences")],
];

export const ERASURE_MAP: Readonly<Record<string, ErasureEntry>> = Object.fromEntries(ENTRIES);

/** The classified entry for a model name; throws on an unknown name. */
export function entryOf(name: string): ErasureEntry {
  const found = ERASURE_MAP[name];
  if (!found) throw new Error(`unclassified model ${name}`);
  return found;
}
