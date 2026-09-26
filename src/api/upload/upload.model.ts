import { Schema, model } from "mongoose";
export const UploadRecord = model(
  "UploadRecord",
  new Schema(
    {
      organizationId: { type: String, required: true, index: true },
      uploadedBy: { type: Schema.Types.ObjectId, required: true },
      purpose: {
        type: String,
        enum: [
          "staff_document",
          "staff_photo",
          "organization_logo",
          "member_photo",
          "clinical_document",
        ],
        required: true,
      },
      key: { type: String, required: true, unique: true },
      contentType: { type: String, required: true },
      sizeBytes: { type: Number, required: true },
      verifiedAt: Date,
      // "LabPanel:<id>" / "Scan:<id>": claimed once so a file never backs two records.
      attachedTo: { type: String, default: null },
    },
    { timestamps: true }
  )
);
