const id = { type: "string", pattern: "^[a-fA-F0-9]{24}$" };
const cents = { type: "integer", minimum: 0, maximum: 100000000 };
const tier = {
  type: "object",
  additionalProperties: false,
  required: ["tierId", "mode"],
  properties: {
    tierId: { type: "string" },
    mode: { type: "string", enum: ["off", "included", "paid"] },
    priceCents: cents,
  },
  description:
    "priceCents is required only for paid tiers. Every active plan tier must appear exactly once. Enabled Everhaus permits included or paid only.",
};
const fields = {
  title: { type: "string", minLength: 1, maxLength: 160 },
  shortName: { type: "string", maxLength: 50 },
  description: { type: "string", maxLength: 3000 },
  status: { type: "string", enum: ["active", "inactive"] },
  categoryId: id,
  locationId: id,
  environmentId: id,
  durationMinutes: { type: "integer", minimum: 1, maximum: 1440 },
  capacityMin: { type: "integer", minimum: 1, maximum: 1000 },
  capacityMax: { type: "integer", minimum: 1, maximum: 1000 },
  basePriceCents: cents,
  lateCancellationFee: {
    type: "object",
    additionalProperties: false,
    required: ["enabled"],
    properties: {
      enabled: { type: "boolean" },
      amountCents: cents,
      windowHours: { type: "integer", minimum: 1, maximum: 720, default: 24 },
    },
    description: "Positive amountCents required when enabled.",
  },
  membershipAccess: {
    type: "array",
    maxItems: 20,
    items: {
      type: "object",
      additionalProperties: false,
      required: ["membershipPlanId", "enabled", "tiers"],
      properties: {
        membershipPlanId: id,
        enabled: { type: "boolean" },
        tiers: { type: "array", minItems: 1, maxItems: 20, items: tier },
      },
    },
  },
  assignedStaffIds: { type: "array", maxItems: 100, uniqueItems: true, items: id },
  assignedTeamRoleId: { ...id, nullable: true },
  imageUploadId: id,
  removeImage: { type: "boolean" },
};
const service = {
  type: "object",
  properties: {
    ...fields,
    id,
    imageUrl: {
      type: "string",
      format: "uri",
      description: "Private signed image URL, expires within 300 seconds",
    },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    scheduledCount: {
      type: "integer",
      minimum: 0,
      description: "Upcoming appointments; zero until appointment module is enabled",
    },
  },
};
const envelope = (data: unknown) => ({
  type: "object",
  required: ["success", "status", "message", "data", "statusCode"],
  properties: {
    success: { type: "boolean" },
    status: { type: "string" },
    message: { type: "string" },
    statusCode: { type: "integer" },
    data,
  },
});
const response = (description: string, data: unknown) => ({
  description,
  content: { "application/json": { schema: data } },
});
const error = { $ref: "#/components/schemas/ErrorResponse" };
const body = (schema: unknown) => ({ required: true, content: { "application/json": { schema } } });
const pathId = [{ in: "path", name: "id", required: true, schema: id }];
const op = (
  summary: string,
  data: unknown,
  extra: Record<string, unknown> = {},
  created = false
) => ({
  summary,
  tags: ["Services"],
  security: [{ staffBearer: [] }],
  responses: {
    [created ? 201 : 200]: response("Success", envelope(data)),
    400: response("Invalid input or references", error),
    401: response("Session expired", error),
    403: response("SERVICES permission or assignment scope denied", error),
    404: response("Service not found in your scope", error),
    503: response("Storage not configured", error),
  },
  ...extra,
});
export const servicePaths = {
  "/api/v1/services": {
    get: op(
      "List unarchived services within assignment scope",
      {
        type: "object",
        properties: {
          items: { type: "array", items: service },
          page: { type: "integer" },
          limit: { type: "integer" },
          total: { type: "integer" },
          totalPages: { type: "integer" },
        },
      },
      {
        parameters: [
          { in: "query", name: "q", schema: { type: "string", maxLength: 160 } },
          { in: "query", name: "status", schema: fields.status },
          { in: "query", name: "categoryId", schema: id },
          { in: "query", name: "page", schema: { type: "integer", minimum: 1, default: 1 } },
          {
            in: "query",
            name: "limit",
            schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
        ],
      }
    ),
    post: op(
      "Create service; SERVICES edit",
      service,
      {
        requestBody: body({
          type: "object",
          additionalProperties: false,
          required: [
            "title",
            "categoryId",
            "locationId",
            "environmentId",
            "durationMinutes",
            "capacityMin",
            "capacityMax",
            "basePriceCents",
          ],
          properties: fields,
        }),
      },
      true
    ),
  },
  "/api/v1/services/{id}": {
    get: op("View service", service, { parameters: pathId }),
    patch: op("Update service; validates merged document; SERVICES edit", service, {
      parameters: pathId,
      requestBody: body({
        type: "object",
        additionalProperties: false,
        minProperties: 1,
        properties: fields,
      }),
    }),
  },
  "/api/v1/services/bulk": {
    post: op(
      "Activate, deactivate or archive selected services; no hard delete",
      { type: "object", properties: { updated: { type: "integer" } } },
      {
        requestBody: body({
          type: "object",
          additionalProperties: false,
          required: ["ids", "action"],
          properties: {
            ids: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: id },
            action: { type: "string", enum: ["activate", "deactivate", "archive"] },
          },
        }),
      }
    ),
  },
  "/api/v1/services/images/presign": {
    post: op(
      "Create actor-bound private S3 image upload; SERVICES edit",
      {
        type: "object",
        properties: {
          uploadId: id,
          url: { type: "string", format: "uri" },
          expiresIn: { type: "integer", enum: [300] },
          headers: {
            type: "object",
            properties: {
              "Content-Type": { type: "string" },
              "x-amz-server-side-encryption": { type: "string", enum: ["AES256"] },
            },
          },
        },
      },
      {
        requestBody: body({
          type: "object",
          additionalProperties: false,
          required: ["contentType", "size"],
          properties: {
            contentType: { type: "string", enum: ["image/jpeg", "image/png", "image/webp"] },
            size: { type: "integer", minimum: 1, maximum: 5242880 },
          },
        }),
      }
    ),
  },
  "/api/v1/services/lookups": {
    get: op(
      "Organization locations, environments and minimal active staff/team names for assignments",
      {
        type: "object",
        properties: {
          locations: {
            type: "array",
            items: {
              type: "object",
              properties: { id, name: { type: "string" }, timeZone: { type: "string" } },
            },
          },
          environments: {
            type: "array",
            items: { type: "object", properties: { id, name: { type: "string" }, locationId: id } },
          },
          staff: {
            type: "array",
            items: { type: "object", properties: { id, name: { type: "string" } } },
          },
          teams: {
            type: "array",
            items: { type: "object", properties: { id, name: { type: "string" } } },
          },
        },
      }
    ),
  },
  "/api/v1/service-categories": {
    get: op("Six configured service categories", {
      type: "array",
      items: {
        type: "object",
        properties: {
          id,
          name: { type: "string" },
          color: { type: "string" },
          sortOrder: { type: "integer" },
        },
      },
    }),
  },
  "/api/v1/membership-plans": {
    get: op("Standalone local plans; pending prices are never fabricated", {
      type: "array",
      items: {
        type: "object",
        properties: {
          id,
          name: { type: "string" },
          brand: { type: "string", enum: ["aerwell", "everhaus"] },
          tiers: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                billingTerm: { type: "string", enum: ["monthly", "quarterly", "bi_annual"] },
                priceCents: cents,
                pricePending: { type: "boolean" },
                active: { type: "boolean" },
              },
            },
          },
        },
      },
    }),
  },
};
