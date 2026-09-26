import { Router } from "express";
import { z } from "zod";
import { registerRoute } from "../../common/http.js";
import { authenticate } from "../../common/middleware/authenticate.js";
import { requirePermission } from "../../common/middleware/permission.js";
import { validate } from "../../common/middleware/validate.js";
import { ServiceResponse } from "../../common/models/serviceResponse.js";
import { asyncHandler } from "../../common/utils/asyncHandler.js";
import {
  bulkSchema,
  imageSchema,
  listSchema,
  objectId,
  serviceCreateSchema,
  servicePatchSchema,
} from "./service.schema.js";
import {
  bulkServices,
  createService,
  getCatalogLookups,
  getCategories,
  getService,
  listServices,
  patchService,
} from "./service.service.js";
import { presignServiceImage } from "./serviceImage.service.js";
export const serviceRouter = Router();
serviceRouter.use(["/services", "/service-categories"], authenticate);
const view = requirePermission("SERVICES", "view");
const edit = requirePermission("SERVICES", "edit");
// Router-level Zod: the services re-parse the same schemas for their types.
const none = z.object({}).strict();
const params = z.object({ id: objectId }).strict();
const input = (schemas: { body?: z.ZodTypeAny; query?: z.ZodTypeAny; params?: z.ZodTypeAny }) =>
  validate({ body: none, query: none, params: none, ...schemas });
// Alfred AI reads the service list through the same guard and handler as GET /services.
registerRoute({
  method: "get",
  path: "/services",
  permission: { module: "SERVICES", level: "view" },
  schema: { query: listSchema },
  handler: listServices,
});
serviceRouter.get(
  "/services",
  view,
  input({ query: listSchema }),
  asyncHandler(async (req, res) => {
    res.json(ServiceResponse.success("Services", await listServices(req)));
  })
);
serviceRouter.get(
  "/services/lookups",
  view,
  input({}),
  asyncHandler(async (req, res) => {
    res.json(ServiceResponse.success("Service form options", await getCatalogLookups(req)));
  })
);
serviceRouter.get(
  "/services/:id",
  view,
  input({ params }),
  asyncHandler(async (req, res) => {
    res.json(ServiceResponse.success("Service", await getService(req)));
  })
);
serviceRouter.post(
  "/services",
  edit,
  input({ body: serviceCreateSchema }),
  asyncHandler(async (req, res) => {
    res.status(201).json(ServiceResponse.success("Service created", await createService(req), 201));
  })
);
serviceRouter.patch(
  "/services/:id",
  edit,
  input({ params, body: servicePatchSchema }),
  asyncHandler(async (req, res) => {
    res.json(ServiceResponse.success("Service updated", await patchService(req)));
  })
);
serviceRouter.post(
  "/services/bulk",
  edit,
  input({ body: bulkSchema }),
  asyncHandler(async (req, res) => {
    res.json(ServiceResponse.success("Services updated", await bulkServices(req)));
  })
);
serviceRouter.post(
  "/services/images/presign",
  edit,
  input({ body: imageSchema }),
  asyncHandler(async (req, res) => {
    res.json(
      ServiceResponse.success(
        "Image upload ready",
        await presignServiceImage(
          req.staff?.organizationId ?? "",
          String(req.staff?._id),
          imageSchema.parse(req.body)
        )
      )
    );
  })
);
serviceRouter.get(
  "/service-categories",
  view,
  input({}),
  asyncHandler(async (req, res) => {
    res.json(ServiceResponse.success("Service categories", await getCategories(req)));
  })
);
