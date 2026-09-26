import { type RequestHandler, Router } from "express";
import { z } from "zod";
import { authenticate } from "../../common/middleware/authenticate.js";
import { requirePermission } from "../../common/middleware/permission.js";
import { validate } from "../../common/middleware/validate.js";
import { ServiceResponse } from "../../common/models/serviceResponse.js";
import { asyncHandler } from "../../common/utils/asyncHandler.js";
import { objectId } from "../service/service.schema.js";
import {
  marketCreateSchema,
  marketPatchSchema,
  modifierCreateSchema,
  modifierPatchSchema,
  planCreateSchema,
  planPatchSchema,
  previewSchema,
  revisionQuerySchema,
} from "./catalog.schema.js";
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
// Router-level Zod: the services re-parse the same schemas for their types.
const none = z.object({}).strict();
const params = z.object({ id: objectId }).strict();
const input = (schemas: { body?: z.ZodTypeAny; query?: z.ZodTypeAny; params?: z.ZodTypeAny }) =>
  validate({ body: none, query: none, params: none, ...schemas });
type Handler = (req: Parameters<RequestHandler>[0]) => Promise<unknown>;
const ok = (message: string, handler: Handler, status = 200) =>
  asyncHandler(async (req, res) => {
    res.status(status).json(ServiceResponse.success(message, await handler(req), status));
  });

catalogRouter.get("/markets", view, input({}), ok("Markets", listMarkets));
catalogRouter.post(
  "/markets",
  settings,
  input({ body: marketCreateSchema }),
  ok("Market created", createMarket, 201)
);
catalogRouter.patch(
  "/markets/:id",
  settings,
  input({ params, body: marketPatchSchema }),
  ok("Market updated", patchMarket)
);
catalogRouter.get("/membership-plans", view, input({}), ok("Membership plans", listPlans));
catalogRouter.get("/membership-plans/:id", view, input({ params }), ok("Membership plan", getPlan));
catalogRouter.post(
  "/membership-plans",
  billing,
  input({ body: planCreateSchema }),
  ok("Membership plan created", createPlan, 201)
);
catalogRouter.patch(
  "/membership-plans/:id",
  billing,
  input({ params, body: planPatchSchema }),
  ok("Membership plan updated", patchPlan)
);
catalogRouter.get("/delivery-modifiers", view, input({}), ok("Delivery modifiers", listModifiers));
catalogRouter.post(
  "/delivery-modifiers",
  billing,
  input({ body: modifierCreateSchema }),
  ok("Delivery modifier created", createModifier, 201)
);
catalogRouter.patch(
  "/delivery-modifiers/:id",
  billing,
  input({ params, body: modifierPatchSchema }),
  ok("Delivery modifier updated", patchModifier)
);
catalogRouter.get(
  "/catalog-revisions",
  view,
  input({ query: revisionQuerySchema }),
  ok("Catalog revisions", listRevisions)
);
catalogRouter.post(
  "/entitlements/preview",
  view,
  input({ body: previewSchema }),
  ok("Entitlement preview", previewEntitlement)
);
