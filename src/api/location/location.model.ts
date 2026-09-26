import { Schema, model } from "mongoose";
const schema = new Schema(
  {
    organizationId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    address: String,
    timeZone: { type: String, default: "America/Los_Angeles" },
    businessHours: {
      type: [
        new Schema(
          {
            weekday: { type: Number, min: 0, max: 6, required: true },
            open: { type: String, required: true },
            close: { type: String, required: true },
            closed: { type: Boolean, default: false },
          },
          { _id: false }
        ),
      ],
      default: () =>
        Array.from({ length: 7 }, (_, weekday) => ({
          weekday,
          open: "07:00",
          close: "19:00",
          closed: false,
        })),
    },
  },
  { timestamps: true }
);
schema.index({ organizationId: 1, name: 1 }, { unique: true });
export const Location = model("Location", schema);
const environmentSchema = new Schema(
  {
    organizationId: { type: String, required: true, index: true },
    locationId: { type: Schema.Types.ObjectId, ref: "Location", required: true },
    name: { type: String, required: true },
  },
  { timestamps: true }
);
environmentSchema.index({ organizationId: 1, locationId: 1, name: 1 }, { unique: true });
export const Environment = model("Environment", environmentSchema);
