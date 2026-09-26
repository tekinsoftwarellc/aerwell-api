import { Router } from "express";
import { authenticate } from "../../common/middleware/authenticate.js";
import { requirePermission } from "../../common/middleware/permission.js";
import { ServiceResponse } from "../../common/models/serviceResponse.js";
import { asyncHandler } from "../../common/utils/asyncHandler.js";
import { imageSchema } from "./service.schema.js";
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
serviceRouter.get(
  "/services",
  view,
  asyncHandler(async (req, res) => {
    res.json(ServiceResponse.success("Services", await listServices(req)));
  })
);
serviceRouter.get(
  "/services/lookups",
  view,
  asyncHandler(async (req, res) => {
    res.json(ServiceResponse.success("Service form options", await getCatalogLookups(req)));
  })
);
serviceRouter.get(
  "/services/:id",
  view,
  asyncHandler(async (req, res) => {
    res.json(ServiceResponse.success("Service", await getService(req)));
  })
);
serviceRouter.post(
  "/services",
  edit,
  asyncHandler(async (req, res) => {
    res.status(201).json(ServiceResponse.success("Service created", await createService(req), 201));
  })
);
serviceRouter.patch(
  "/services/:id",
  edit,
  asyncHandler(async (req, res) => {
    res.json(ServiceResponse.success("Service updated", await patchService(req)));
  })
);
serviceRouter.post(
  "/services/bulk",
  edit,
  asyncHandler(async (req, res) => {
    res.json(ServiceResponse.success("Services updated", await bulkServices(req)));
  })
);
serviceRouter.post(
  "/services/images/presign",
  edit,
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
  asyncHandler(async (req, res) => {
    res.json(ServiceResponse.success("Service categories", await getCategories(req)));
  })
);
