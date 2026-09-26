import { type InferSchemaType, Schema, model } from "mongoose";

/**
 * Alfred AI persistence. Everything is keyed by organizationId + staffId, and
 * every read filters on both, so one staff member's history can never be loaded
 * into another's prompt. Only user and assistant TEXT is stored: tool calls and
 * raw tool results live only inside one request and are never persisted.
 */
const org = { type: String, required: true };
const staff = { type: Schema.Types.ObjectId, ref: "StaffMember", required: true };

const conversationSchema = new Schema(
  {
    organizationId: org,
    staffId: staff,
    title: { type: String, default: "New conversation", maxlength: 80 },
    lastMessageAt: { type: Date, default: null },
  },
  { timestamps: true }
);
conversationSchema.index({ organizationId: 1, staffId: 1, updatedAt: -1 });
export const AlfredConversation = model("AlfredConversation", conversationSchema);

export const MESSAGE_ROLES = ["user", "assistant"] as const;
const messageSchema = new Schema(
  {
    organizationId: org,
    staffId: staff,
    conversationId: { type: Schema.Types.ObjectId, ref: "AlfredConversation", required: true },
    role: { type: String, enum: MESSAGE_ROLES, required: true },
    text: { type: String, required: true, maxlength: 8000 },
    draftIds: { type: [Schema.Types.ObjectId], default: [] },
  },
  { timestamps: true }
);
messageSchema.index({ organizationId: 1, staffId: 1, conversationId: 1, createdAt: 1 });
export const AlfredMessage = model("AlfredMessage", messageSchema);

export const DRAFT_KINDS = [
  "book_appointment",
  "add_note",
  "create_flag",
  "request_pto",
  "supplement_order",
] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];
export const DRAFT_STATUSES = ["pending", "confirming", "confirmed", "cancelled"] as const;
/**
 * A write Alfred proposed. `input` is the exact route input (params/body) that
 * was validated by the target route's own schema when the draft was made; it is
 * validated and permission-checked again, as the confirming staff member, when
 * they confirm. `preview` is built by the server from database lookups, never
 * from model text, so the dialog shows what will really be written.
 */
const draftSchema = new Schema(
  {
    organizationId: org,
    staffId: staff,
    conversationId: { type: Schema.Types.ObjectId, default: null },
    kind: { type: String, enum: DRAFT_KINDS, required: true },
    memberId: { type: Schema.Types.ObjectId, default: null },
    input: { type: Schema.Types.Mixed, required: true },
    preview: { type: Schema.Types.Mixed, required: true },
    status: { type: String, enum: DRAFT_STATUSES, default: "pending" },
    /** When the current "confirming" claim was taken (a stale claim means a crash). */
    confirmingAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    result: { type: Schema.Types.Mixed, default: null },
    decidedAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false }
);
draftSchema.index({ organizationId: 1, staffId: 1, createdAt: -1 });
export const AlfredDraft = model("AlfredDraft", draftSchema);

export const SUGGESTION_CONTEXTS = ["member_overview", "visit", "dashboard"] as const;
export type SuggestionContext = (typeof SUGGESTION_CONTEXTS)[number];
export const SUGGESTION_ACTIONS = ["schedule", "review", "follow_up", "note", "flag"] as const;
export const SUGGESTION_STATUSES = ["open", "done", "dismissed"] as const;
/** One generated suggestion. Nothing is written to the record by generating it. */
const suggestionSchema = new Schema(
  {
    organizationId: org,
    staffId: staff,
    context: { type: String, enum: SUGGESTION_CONTEXTS, required: true },
    memberId: { type: Schema.Types.ObjectId, default: null },
    appointmentId: { type: Schema.Types.ObjectId, default: null },
    batchId: { type: Schema.Types.ObjectId, required: true },
    title: { type: String, required: true, maxlength: 160 },
    detail: { type: String, required: true, maxlength: 600 },
    actionType: { type: String, enum: SUGGESTION_ACTIONS, required: true },
    sources: { type: [String], default: [] },
    status: { type: String, enum: SUGGESTION_STATUSES, default: "open" },
    decidedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
suggestionSchema.index({
  organizationId: 1,
  staffId: 1,
  context: 1,
  memberId: 1,
  appointmentId: 1,
  createdAt: -1,
});
export const AlfredSuggestion = model("AlfredSuggestion", suggestionSchema);

export const USAGE_FEATURES = ["chat", "suggestions"] as const;
/** Token usage per model call. Never any prompt, reply or tool content. */
const usageSchema = new Schema(
  {
    organizationId: org,
    staffId: staff,
    feature: { type: String, enum: USAGE_FEATURES, required: true },
    modelId: { type: String, required: true },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    latencyMs: { type: Number, default: 0 },
    toolCalls: { type: Number, default: 0 },
    outcome: { type: String, enum: ["ok", "error"], required: true },
    errorName: { type: String, default: null },
  },
  { timestamps: true, versionKey: false }
);
usageSchema.index({ organizationId: 1, createdAt: -1 });
export const AlfredUsage = model("AlfredUsage", usageSchema);
export type AlfredDraftData = InferSchemaType<typeof draftSchema>;
