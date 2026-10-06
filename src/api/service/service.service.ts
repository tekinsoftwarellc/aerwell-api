import type { Request } from "express";
import { type FilterQuery, type InferSchemaType, Types } from "mongoose";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../common/errors/AppError.js";
import { publishCatalogChange } from "../alfred-partner/outbox/catalogEvents.js";
import { Appointment, UPCOMING_STATUSES } from "../appointment/appointment.model.js";
import { Market } from "../catalog/catalog.model.js";
import { assertRetailFitsPlans } from "../catalog/catalog.service.js";
import {
  assertExpectedVersion,
  inCatalogTransaction,
  recordRevisions,
  saveVersioned,
} from "../catalog/versioning.js";
import { Environment, Location } from "../location/location.model.js";
import { Role } from "../role/role.model.js";
import { StaffMember } from "../staff/staff.model.js";
import { Service, ServiceCategory } from "./service.model.js";
import {
  type ServiceInput,
  bulkSchema,
  listSchema,
  objectId,
  serviceCreateSchema,
  servicePatchSchema,
} from "./service.schema.js";
import { attachServiceImage, serviceImageUrl } from "./serviceImage.service.js";
type ServiceData = InferSchemaType<typeof Service.schema>;
export function catalogScope(req: Request): FilterQuery<ServiceData> {
  const filter: FilterQuery<ServiceData> = {
    organizationId: req.staff?.organizationId,
    deletedAt: null,
  };
  if (req.permission?.scope === "own")
    filter.$or = [
      { assignedStaffIds: req.staff?._id },
      ...(req.staff?.roleId ? [{ assignedTeamRoleId: req.staff.roleId }] : []),
    ];
  return filter;
}
async function serialize(doc: InstanceType<typeof Service>) {
  const raw = doc.toObject();
  const { __v, _id, imageKey, membershipAccess, ...value } = raw as typeof raw & {
    __v?: number;
    membershipAccess?: unknown;
  };
  return {
    ...value,
    id: String(_id),
    imageUrl: await serviceImageUrl(imageKey ?? undefined),
    // Upcoming live bookings (one count per row; ponytail: aggregate if pages grow past ~50).
    scheduledCount: await Appointment.countDocuments({
      organizationId: doc.organizationId,
      serviceId: doc._id,
      status: { $in: UPCOMING_STATUSES },
      startAt: { $gte: new Date() },
    }),
  };
}
async function validateCatalogLinks(organizationId: string, input: ServiceInput, selfId?: string) {
  const markets = await Market.countDocuments({ _id: { $in: input.marketIds }, organizationId });
  if (markets !== input.marketIds.length)
    throw new BadRequestError("Select markets from this organization");
  if (!input.bundleComponentIds.length) return;
  if (selfId && input.bundleComponentIds.includes(selfId))
    throw new BadRequestError("A bundle cannot contain itself");
  const components = await Service.find({
    _id: { $in: input.bundleComponentIds },
    organizationId,
    deletedAt: null,
  }).select("bundleComponentIds");
  if (components.length !== input.bundleComponentIds.length)
    throw new BadRequestError("Select bundle components from this organization's catalog");
  if (components.some((c) => c.bundleComponentIds.length))
    throw new BadRequestError("A bundle component cannot itself be a bundle");
  if (
    selfId &&
    (await Service.exists({ organizationId, bundleComponentIds: selfId, deletedAt: null }))
  )
    throw new BadRequestError("This service is a bundle component and cannot become a bundle");
}
async function validateReferences(req: Request, input: ServiceInput, selfId?: string) {
  const organizationId = req.staff?.organizationId ?? "";
  const checks = await Promise.all([
    ServiceCategory.exists({ _id: input.categoryId, organizationId }),
    !input.locationId || Location.exists({ _id: input.locationId, organizationId }),
    !input.environmentId ||
      Environment.exists({
        _id: input.environmentId,
        locationId: input.locationId,
        organizationId,
      }),
  ]);
  if (checks.some((v) => !v))
    throw new BadRequestError("Select a category, location and environment from this organization");
  if (
    input.assignedTeamRoleId &&
    !(await Role.exists({ _id: input.assignedTeamRoleId, organizationId }))
  )
    throw new BadRequestError("Select a team from this organization");
  const count = await StaffMember.countDocuments({
    _id: { $in: input.assignedStaffIds },
    organizationId,
    accountStatus: "active",
    deletedAt: null,
  });
  if (count !== input.assignedStaffIds.length)
    throw new BadRequestError("Assign active staff from this organization");
  if (
    req.permission?.scope === "own" &&
    !input.assignedStaffIds.includes(String(req.staff?._id)) &&
    (!req.staff?.roleId || input.assignedTeamRoleId !== String(req.staff.roleId))
  )
    throw new ForbiddenError("Own services must be assigned to you or your team");
  await validateCatalogLinks(organizationId, input, selfId);
}
export async function listServices(req: Request) {
  const query = listSchema.parse(req.query);
  const filter = catalogScope(req);
  if (query.status) filter.status = query.status;
  if (query.categoryId) filter.categoryId = query.categoryId;
  if (query.q)
    filter.title = { $regex: query.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
  const [docs, total] = await Promise.all([
    Service.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    Service.countDocuments(filter),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / query.limit));
  return {
    items: await Promise.all(docs.map(serialize)),
    pagination: {
      total,
      page: query.page,
      limit: query.limit,
      totalPages,
      hasNext: query.page < totalPages,
      hasPrev: query.page > 1,
    },
  };
}
async function findService(req: Request) {
  const id = objectId.parse(req.params["id"]);
  const doc = await Service.findOne({ ...catalogScope(req), _id: id });
  if (!doc) throw new NotFoundError("Service not found");
  return doc;
}
export async function getService(req: Request) {
  return serialize(await findService(req));
}
async function applyImage(req: Request, input: ServiceInput) {
  if (input.removeImage) return { imageKey: undefined };
  if (input.imageUploadId)
    return {
      imageKey: await attachServiceImage(
        req.staff?.organizationId ?? "",
        String(req.staff?._id),
        input.imageUploadId
      ),
    };
  return {};
}
async function uniqueSlug(organizationId: string, title: string) {
  const root =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "service";
  if (!(await Service.exists({ organizationId, slug: root }))) return root;
  return `${root}-${new Types.ObjectId().toHexString().slice(-6)}`;
}
export async function createService(req: Request) {
  const input = serviceCreateSchema.parse(req.body);
  await validateReferences(req, input);
  const organizationId = req.staff?.organizationId ?? "";
  if (input.slug && (await Service.exists({ organizationId, slug: input.slug })))
    throw new ConflictError(
      "Another service already uses this identifier",
      undefined,
      "SLUG_TAKEN"
    );
  const { imageUploadId, removeImage, ...data } = input;
  const image = await applyImage(req, input);
  const doc = new Service({
    ...data,
    ...image,
    slug: input.slug ?? (await uniqueSlug(organizationId, input.title)),
    organizationId,
  });
  await saveVersioned(req, "service", doc, "created");
  await publishCatalogChange(organizationId, [doc._id]);
  return serialize(doc);
}
function editable(doc: InstanceType<typeof Service>) {
  return {
    title: doc.title,
    shortName: doc.shortName,
    description: doc.description,
    status: doc.status,
    categoryId: String(doc.categoryId),
    modality: doc.modality,
    marketScope: doc.marketScope,
    marketIds: doc.marketIds.map(String),
    bundleComponentIds: doc.bundleComponentIds.map(String),
    locationId: doc.locationId ? String(doc.locationId) : null,
    environmentId: doc.environmentId ? String(doc.environmentId) : null,
    durationMinutes: doc.durationMinutes,
    capacityMin: doc.capacityMin,
    capacityMax: doc.capacityMax,
    basePriceCents: doc.basePriceCents,
    lateCancellationFee: {
      enabled: doc.lateCancellationFee.enabled,
      windowHours: doc.lateCancellationFee.windowHours,
      ...(doc.lateCancellationFee.amountCents == null
        ? {}
        : { amountCents: doc.lateCancellationFee.amountCents }),
    },
    assignedStaffIds: doc.assignedStaffIds.map(String),
    assignedTeamRoleId: doc.assignedTeamRoleId ? String(doc.assignedTeamRoleId) : null,
  };
}
export async function patchService(req: Request) {
  const { expectedVersion, ...patch } = servicePatchSchema.parse(req.body);
  const doc = await findService(req);
  assertExpectedVersion(doc, expectedVersion);
  const input = serviceCreateSchema.parse({ ...editable(doc), ...patch });
  await validateReferences(req, input, String(doc._id));
  if ((input.basePriceCents === null) !== (doc.basePriceCents == null))
    await assertRetailFitsPlans(req.staff?.organizationId ?? "", doc, input.basePriceCents);
  const { imageUploadId, removeImage, slug, ...data } = input;
  doc.set({ ...data, ...(await applyImage(req, input)) });
  await saveVersioned(req, "service", doc, "updated");
  await publishCatalogChange(doc.organizationId, [doc._id]);
  return serialize(doc);
}
export async function bulkServices(req: Request) {
  const { ids, action } = bulkSchema.parse(req.body);
  const filter = { ...catalogScope(req), _id: { $in: ids.map((id) => new Types.ObjectId(id)) } };
  if ((await Service.countDocuments(filter)) !== ids.length)
    throw new NotFoundError("One or more selected services are unavailable; refresh the list");
  const change =
    action === "archive"
      ? { deletedAt: new Date(), status: "inactive" }
      : { status: action === "activate" ? "active" : "inactive" };
  return inCatalogTransaction(async (session) => {
    const result = await Service.updateMany(
      filter,
      { $set: change, $inc: { version: 1 } },
      { session }
    );
    const docs = await Service.find({ _id: { $in: ids } }).session(session);
    await recordRevisions(req, "service", docs, action, session);
    return { updated: result.matchedCount };
  }).then(async (done) => {
    await publishCatalogChange(catalogScope(req)["organizationId"] as string, ids);
    return done;
  });
}
export async function getCategories(req: Request) {
  return (
    await ServiceCategory.find({ organizationId: req.staff?.organizationId })
      .sort({ sortOrder: 1 })
      .lean()
  ).map(({ _id, organizationId, __v, ...v }) => ({ ...v, id: String(_id) }));
}
export async function getCatalogLookups(req: Request) {
  const organizationId = req.staff?.organizationId;
  const [locations, environments, staff, teams] = await Promise.all([
    Location.find({ organizationId }).select("name timeZone").lean(),
    Environment.find({ organizationId }).select("name locationId").lean(),
    StaffMember.find({ organizationId, accountStatus: "active", deletedAt: null })
      .select("firstName lastName")
      .lean(),
    Role.find({ organizationId }).select("name").lean(),
  ]);
  return {
    locations: locations.map((v) => ({ id: String(v._id), name: v.name, timeZone: v.timeZone })),
    environments: environments.map((v) => ({
      id: String(v._id),
      name: v.name,
      locationId: String(v.locationId),
    })),
    staff: staff.map((v) => ({ id: String(v._id), name: `${v.firstName} ${v.lastName}` })),
    teams: teams.map((v) => ({ id: String(v._id), name: v.name })),
  };
}
