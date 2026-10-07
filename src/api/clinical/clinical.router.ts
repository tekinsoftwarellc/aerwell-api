import { Router } from "express";
import { idParams, secured } from "../../common/http.js";
import type { PermissionModule } from "../role/permission.types.js";
import {
  createBiomarker,
  listBiomarkers,
  listTemplates,
  patchBiomarker,
} from "./catalog.service.js";
import {
  LIST_BODIES,
  biomarkerCreate,
  biomarkerParams,
  biomarkerPatch,
  biomarkerQuery,
  discontinueBody,
  injectionBody,
  linkVisitBody,
  panelCreate,
  panelParams,
  panelQuery,
  protocolCreate,
  protocolParams,
  protocolPatch,
  protocolQuery,
  reviewBody,
  scanCreate,
  scanParams,
  scanQuery,
  scanTrendParams,
  scoreCreate,
  scoreQuery,
  trendParams,
  trendQuery,
  wearableQuery,
} from "./clinical.schema.js";
import {
  LIST_MODULE,
  type ListKind,
  createScore,
  getList,
  healthSummary,
  listScores,
  putList,
  wearables,
} from "./health.service.js";
import {
  biomarkerTrend,
  createPanel,
  getPanel,
  listPanels,
  panelDocument,
  reviewPanel,
} from "./labs.service.js";
import {
  completeProtocol,
  createProtocol,
  discontinueProtocol,
  getProtocol,
  listProtocols,
  listRevisions,
  logInjection,
  patchProtocol,
} from "./protocols.service.js";
import { linkVisit } from "./reportLink.js";
import {
  createScan,
  getScan,
  listScans,
  reviewScan,
  scanDocument,
  scanTrend,
} from "./scans.service.js";

export const clinicalRouter = Router();
const r = clinicalRouter;
const can = (module: PermissionModule, level: "view" | "edit" | "master") => ({ module, level });
const labs = (level: "view" | "edit" | "master") => can("LABS_SCANS", level);
const protocols = (level: "view" | "edit") => can("PROTOCOLS", level);
const member = (suffix: string) => `/members/:id${suffix}`;

// Catalog (clinic configuration).
secured(r, "get", "/biomarkers", labs("view"), { query: biomarkerQuery }, listBiomarkers);
secured(r, "post", "/biomarkers", labs("master"), { body: biomarkerCreate }, createBiomarker, 201);
secured(
  r,
  "patch",
  "/biomarkers/:biomarkerId",
  labs("master"),
  { params: biomarkerParams, body: biomarkerPatch },
  patchBiomarker
);
secured(r, "get", "/lab-panel-templates", labs("view"), {}, listTemplates);

// Health tab.
secured(r, "get", member("/health-summary"), labs("view"), { params: idParams }, healthSummary);
secured(
  r,
  "get",
  member("/scores"),
  labs("view"),
  { params: idParams, query: scoreQuery },
  listScores
);
secured(
  r,
  "post",
  member("/scores"),
  labs("edit"),
  { params: idParams, body: scoreCreate },
  createScore,
  201
);
secured(
  r,
  "get",
  member("/wearables/summary"),
  labs("view"),
  { params: idParams, query: wearableQuery },
  wearables(7)
);
secured(
  r,
  "get",
  member("/wearables/history"),
  labs("view"),
  { params: idParams, query: wearableQuery },
  wearables(90)
);
const LIST_PATHS: Record<ListKind, string> = {
  goals: "/goals",
  medical_history: "/medical-history",
  allergies: "/allergies",
  medications: "/medications",
  supplements: "/supplements",
};
for (const [kind, path] of Object.entries(LIST_PATHS) as [ListKind, string][]) {
  const module = LIST_MODULE[kind];
  secured(r, "get", member(path), can(module, "view"), { params: idParams }, getList(kind));
  secured(
    r,
    "put",
    member(path),
    can(module, "edit"),
    { params: idParams, body: LIST_BODIES[kind] },
    putList(kind)
  );
}

// Labs tab.
secured(r, "get", member("/lab-panels"), labs("view"), { params: idParams }, listPanels);
secured(
  r,
  "post",
  member("/lab-panels"),
  labs("edit"),
  { params: idParams, body: panelCreate },
  createPanel,
  201
);
secured(
  r,
  "get",
  member("/lab-panels/:panelId"),
  labs("view"),
  { params: panelParams, query: panelQuery },
  getPanel
);
secured(
  r,
  "post",
  member("/lab-panels/:panelId/review"),
  labs("edit"),
  { params: panelParams, body: reviewBody },
  reviewPanel
);
secured(
  r,
  "put",
  member("/lab-panels/:panelId/visit"),
  labs("edit"),
  { params: panelParams, body: linkVisitBody },
  linkVisit("lab")
);
secured(
  r,
  "get",
  member("/lab-panels/:panelId/document"),
  labs("view"),
  { params: panelParams },
  panelDocument
);
secured(
  r,
  "get",
  member("/biomarkers/:biomarkerId/trend"),
  labs("view"),
  { params: trendParams, query: trendQuery },
  biomarkerTrend
);

// Scans tab.
secured(
  r,
  "get",
  member("/scans"),
  labs("view"),
  { params: idParams, query: scanQuery },
  listScans
);
secured(
  r,
  "post",
  member("/scans"),
  labs("edit"),
  { params: idParams, body: scanCreate },
  createScan,
  201
);
secured(
  r,
  "get",
  member("/scans/metrics/:metric/trend"),
  labs("view"),
  { params: scanTrendParams, query: trendQuery },
  scanTrend
);
secured(r, "get", member("/scans/:scanId"), labs("view"), { params: scanParams }, getScan);
secured(
  r,
  "post",
  member("/scans/:scanId/review"),
  labs("edit"),
  { params: scanParams, body: reviewBody },
  reviewScan
);
secured(
  r,
  "put",
  member("/scans/:scanId/visit"),
  labs("edit"),
  { params: scanParams, body: linkVisitBody },
  linkVisit("scan")
);
secured(
  r,
  "get",
  member("/scans/:scanId/document"),
  labs("view"),
  { params: scanParams },
  scanDocument
);

// Protocols tab.
secured(
  r,
  "get",
  member("/protocols"),
  protocols("view"),
  { params: idParams, query: protocolQuery },
  listProtocols
);
secured(
  r,
  "post",
  member("/protocols"),
  protocols("edit"),
  { params: idParams, body: protocolCreate },
  createProtocol,
  201
);
secured(
  r,
  "get",
  member("/protocols/:protocolId"),
  protocols("view"),
  { params: protocolParams },
  getProtocol
);
secured(
  r,
  "patch",
  member("/protocols/:protocolId"),
  protocols("edit"),
  { params: protocolParams, body: protocolPatch },
  patchProtocol
);
secured(
  r,
  "post",
  member("/protocols/:protocolId/discontinue"),
  protocols("edit"),
  { params: protocolParams, body: discontinueBody },
  discontinueProtocol
);
secured(
  r,
  "post",
  member("/protocols/:protocolId/complete"),
  protocols("edit"),
  { params: protocolParams },
  completeProtocol
);
secured(
  r,
  "get",
  member("/protocols/:protocolId/revisions"),
  protocols("view"),
  { params: protocolParams },
  listRevisions
);
secured(
  r,
  "post",
  member("/protocols/:protocolId/injections"),
  protocols("edit"),
  { params: protocolParams, body: injectionBody },
  logInjection,
  201
);
