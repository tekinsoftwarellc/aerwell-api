import { Router } from "express";
import { idParams, secured } from "../../common/http.js";
import { decideNextStep, generateNextSteps, listNextSteps } from "./suggestions.service.js";
import { consentBody, decisionBody, suggestionParams, visitPatch } from "./visit.schema.js";
import {
  recordConsent,
  revokeConsent,
  transcript,
  updateVisit,
  visitState,
} from "./visit.service.js";

// W9 visit workspace. Route guard = APPOINTMENTS; the services add CLINICAL_NOTES
// level + own scope (visitTarget). Starting and completing the visit use the W6
// status route (checked_in -> in_progress -> completed). Live audio is the
// WebSocket in visit.socket.ts.
export const visitRouter = Router();
const r = visitRouter;
const appts = (level: "view" | "edit") => ({ module: "APPOINTMENTS", level }) as const;

secured(r, "get", "/appointments/:id/visit", appts("view"), { params: idParams }, visitState);
secured(
  r,
  "patch",
  "/appointments/:id/visit",
  appts("edit"),
  { params: idParams, body: visitPatch },
  updateVisit
);
secured(
  r,
  "post",
  "/appointments/:id/visit/consent",
  appts("edit"),
  { params: idParams, body: consentBody },
  recordConsent,
  201
);
secured(
  r,
  "post",
  "/appointments/:id/visit/consent/revoke",
  appts("edit"),
  { params: idParams },
  revokeConsent
);
secured(r, "get", "/appointments/:id/transcript", appts("view"), { params: idParams }, transcript);
secured(
  r,
  "get",
  "/appointments/:id/next-steps",
  appts("view"),
  { params: idParams },
  listNextSteps
);
secured(
  r,
  "post",
  "/appointments/:id/next-steps",
  appts("edit"),
  { params: idParams },
  generateNextSteps,
  201
);
secured(
  r,
  "post",
  "/appointments/:id/next-steps/:sid/decision",
  appts("edit"),
  { params: suggestionParams, body: decisionBody },
  decideNextStep
);
