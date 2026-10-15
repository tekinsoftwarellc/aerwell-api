import { type InferSchemaType, Schema, model } from "mongoose";

/** Plan grants owed to Alfred (`POST /internal/plan-grants`). Body is a snapshot; eventId is unique so a repeat is a no-op. */
export interface PlanGrantBody {
  alfredAccountId: string;
  tierRef: string;
  paid: boolean;
  status: "active" | "paused" | "cancelled";
  periodStart: string;
  periodEnd: string | null;
  eventId: string;
}

const planGrantOutboxSchema = new Schema(
  {
    eventId: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: Schema.Types.Mixed, required: true },
    status: {
      type: String,
      enum: ["pending", "sending", "sent", "failed", "dead"],
      default: "pending",
    },
    attempts: { type: Number, default: 0, min: 0 },
    nextAttemptAt: { type: Date, default: () => new Date() },
    lastError: { type: String, set: (v?: string) => v?.slice(0, 500) },
    lastStatusCode: Number,
    sentAt: Date,
  },
  { timestamps: true }
);
planGrantOutboxSchema.index({ eventId: 1 }, { unique: true });
planGrantOutboxSchema.index({ status: 1, nextAttemptAt: 1, createdAt: 1 });

export type PlanGrantOutboxRow = InferSchemaType<typeof planGrantOutboxSchema>;
export const PlanGrantOutbox = model("PlanGrantOutbox", planGrantOutboxSchema, "plan_grant_outbox");
