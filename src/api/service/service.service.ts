import type { Request } from "express";
import { type FilterQuery, type InferSchemaType, Types } from "mongoose";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../common/errors/AppError.js";
import { audit } from "../audit/audit.js";
import { Environment, Location } from "../location/location.model.js";
import { Role } from "../role/role.model.js";
import { StaffMember } from "../staff/staff.model.js";
import { MembershipPlan, Service, ServiceCategory } from "./service.model.js";
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
  const { __v, _id, imageKey, ...value } = raw;
  return {
    ...value,
    id: String(_id),
    imageUrl: await serviceImageUrl(imageKey ?? undefined),
    scheduledCount: 0,
  };
}
async function validateMemberships(organizationId: string, input: ServiceInput) {
  for (const access of input.membershipAccess) {
    const plan = await MembershipPlan.findOne({ _id: access.membershipPlanId, organizationId });
    if (!plan) throw new BadRequestError("Select a membership plan from this organization");
    const tiers = plan.tiers.filter((t) => t.active).map((t) => t.id);
    const requested = access.tiers.map((t) => t.tierId);
    if (
      new Set(requested).size !== requested.length ||
      tiers.length !== requested.length ||
      requested.some((t) => !tiers.includes(t))
    )
      throw new BadRequestError("Provide each active membership tier exactly once");
    if (plan.brand === "everhaus" && access.enabled && access.tiers.some((t) => t.mode === "off"))
      throw new BadRequestError(
        "Everhaus membership access must be Included or Paid; disable the group to turn it off"
      );
  }
}
async function validateReferences(req: Request, input: ServiceInput) {
  const organizationId = req.staff?.organizationId ?? "";
  const checks = await Promise.all([
    ServiceCategory.exists({ _id: input.categoryId, organizationId }),
    Location.exists({ _id: input.locationId, organizationId }),
    Environment.exists({ _id: input.environmentId, locationId: input.locationId, organizationId }),
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
  await validateMemberships(organizationId, input);
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
export async function createService(req: Request) {
  const input = serviceCreateSchema.parse(req.body);
  await validateReferences(req, input);
  const { imageUploadId, removeImage, ...data } = input;
  const image = await applyImage(req, input);
  const doc = await Service.create({
    ...data,
    ...image,
    organizationId: req.staff?.organizationId,
  });
  await audit(req, "created", "service", String(doc._id));
  return serialize(doc);
}
function editable(doc: InstanceType<typeof Service>) {
  return {
    title: doc.title,
    shortName: doc.shortName,
    description: doc.description,
    status: doc.status,
    categoryId: String(doc.categoryId),
    locationId: String(doc.locationId),
    environmentId: String(doc.environmentId),
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
    membershipAccess: doc.membershipAccess.map((m) => ({
      membershipPlanId: String(m.membershipPlanId),
      enabled: m.enabled,
      tiers: m.tiers.map((t) => ({
        tierId: t.tierId,
        mode: t.mode,
        ...(t.priceCents === undefined ? {} : { priceCents: t.priceCents }),
      })),
    })),
    assignedStaffIds: doc.assignedStaffIds.map(String),
    assignedTeamRoleId: doc.assignedTeamRoleId ? String(doc.assignedTeamRoleId) : null,
  };
}
export async function patchService(req: Request) {
  const patch = servicePatchSchema.parse(req.body);
  const doc = await findService(req);
  const input = serviceCreateSchema.parse({ ...editable(doc), ...patch });
  await validateReferences(req, input);
  const { imageUploadId, removeImage, ...data } = input;
  doc.set({ ...data, ...(await applyImage(req, input)) });
  await doc.save();
  await audit(req, "updated", "service", String(doc._id));
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
  const result = await Service.updateMany(filter, { $set: change });
  for (const id of ids) await audit(req, action, "service", id);
  return { updated: result.matchedCount };
}
export async function getCategories(req: Request) {
  return (
    await ServiceCategory.find({ organizationId: req.staff?.organizationId })
      .sort({ sortOrder: 1 })
      .lean()
  ).map(({ _id, organizationId, __v, ...v }) => ({ ...v, id: String(_id) }));
}
export async function getPlans(req: Request) {
  return (
    await MembershipPlan.find({ organizationId: req.staff?.organizationId })
      .sort({ name: 1 })
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
