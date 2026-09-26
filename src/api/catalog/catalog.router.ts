import { type RequestHandler, Router } from "express";
import { authenticate } from "../../common/middleware/authenticate.js";
import { requirePermission } from "../../common/middleware/permission.js";
import { ServiceResponse } from "../../common/models/serviceResponse.js";
import { asyncHandler } from "../../common/utils/asyncHandler.js";
import {
  createMarket,
  createModifier,
  createPlan,
  getPlan,
  listMarkets,
  listModifiers,
  listPlans,
  listRevisions,
  patchMarket,
  patchModifier,
  patchPlan,
  previewEntitlement,
} from "./catalog.service.js";

export const catalogRouter = Router();
catalogRouter.use(
  ["/markets", "/membership-plans", "/delivery-modifiers", "/catalog-revisions", "/entitlements"],
  authenticate
);
// Reads follow the catalog (SERVICES); prices/fees are BILLING; markets are
// organization geography (SYSTEM_SETTINGS).
const view = requirePermission("SERVICES", "view");
const billing = requirePermission("BILLING", "edit");
const settings = requirePermission("SYSTEM_SETTINGS", "edit");
type Handler = (req: Parameters<RequestHandler>[0]) => Promise<unknown>;
const ok = (message: string, handler: Handler, status = 200) =>
  asyncHandler(async (req, res) => {
    res.status(status).json(ServiceResponse.success(message, await handler(req), status));
  });

catalogRouter.get("/markets", view, ok("Markets", listMarkets));
catalogRouter.post("/markets", settings, ok("Market created", createMarket, 201));
catalogRouter.patch("/markets/:id", settings, ok("Market updated", patchMarket));
catalogRouter.get("/membership-plans", view, ok("Membership plans", listPlans));
catalogRouter.get("/membership-plans/:id", view, ok("Membership plan", getPlan));
catalogRouter.post("/membership-plans", billing, ok("Membership plan created", createPlan, 201));
catalogRouter.patch("/membership-plans/:id", billing, ok("Membership plan updated", patchPlan));
catalogRouter.get("/delivery-modifiers", view, ok("Delivery modifiers", listModifiers));
catalogRouter.post(
  "/delivery-modifiers",
  billing,
  ok("Delivery modifier created", createModifier, 201)
);
catalogRouter.patch(
  "/delivery-modifiers/:id",
  billing,
  ok("Delivery modifier updated", patchModifier)
);
catalogRouter.get("/catalog-revisions", view, ok("Catalog revisions", listRevisions));
catalogRouter.post("/entitlements/preview", view, ok("Entitlement preview", previewEntitlement));
