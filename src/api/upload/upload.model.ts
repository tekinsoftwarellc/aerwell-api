import { Schema, model } from "mongoose";
export const UploadRecord = model(
  "UploadRecord",
  new Schema(
    {
      organizationId: { type: String, required: true, index: true },
      uploadedBy: { type: Schema.Types.ObjectId, required: true },
      purpose: {
        type: String,
        enum: ["staff_document", "staff_photo", "organization_logo"],
        required: true,
      },
      key: { type: String, required: true, unique: true },
      contentType: { type: String, required: true },
      sizeBytes: { type: Number, required: true },
      verifiedAt: Date,
    },
    { timestamps: true }
  )
);
