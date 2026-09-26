import { z } from "zod";
import { objectId } from "../../common/http.js";
import { CONSENT_METHODS } from "./visit.model.js";

export const consentBody = z
  .object({ method: z.enum(CONSENT_METHODS), consentVersion: z.string().min(1).max(40) })
  .strict();
export const visitPatch = z.object({ summary: z.string().trim().max(8000) }).strict();
export const suggestionParams = z.object({ id: objectId, sid: objectId }).strict();
export const decisionBody = z
  .object({
    decision: z.enum(["accepted", "rejected"]),
    title: z.string().trim().min(1).max(160).optional(),
    detail: z.string().trim().min(1).max(800).optional(),
  })
  .strict()
  .refine((v) => v.decision === "accepted" || (v.title === undefined && v.detail === undefined), {
    path: ["decision"],
    message: "Only an accepted suggestion can be edited",
  });
