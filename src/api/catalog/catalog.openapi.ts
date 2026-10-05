const id = { type: "string", pattern: "^[a-fA-F0-9]{24}$" };
const cents = { type: "integer", minimum: 0, maximum: 100000000 };
const slug = { type: "string", pattern: "^[a-z0-9]+(?:[-_][a-z0-9]+)*$", maxLength: 80 };
const ids = (max: number) => ({ type: "array", maxItems: max, uniqueItems: true, items: id });
const str = { type: "string" };
const bool = { type: "boolean" };
const stamped = {
  id,
  version: { type: "integer", minimum: 0, description: "Optimistic-concurrency version" },
  createdAt: { type: "string", format: "date-time" },
  updatedAt: { type: "string", format: "date-time" },
};
const expectedVersion = {
  type: "integer",
  minimum: 0,
  description: "Optional; stale value returns 409 VERSION_CONFLICT",
};

const marketFields = {
  slug,
  name: { type: "string", minLength: 1, maxLength: 120 },
  active: bool,
  locationIds: ids(50),
};
const pricing = {
  type: "object",
  required: ["mode"],
  properties: {
    mode: { type: "string", enum: ["retail", "discount", "custom", "included"] },
    discountBps: { type: "integer", minimum: 1, maximum: 10000, description: "mode=discount" },
    customPriceCents: { ...cents, description: "mode=custom" },
  },
  description:
    "Price when no allowance unit applies. Discounts are integer basis points; the discount rounds half up.",
};
const benefit = {
  type: "object",
  additionalProperties: false,
  required: ["serviceId", "access"],
  properties: {
    id: { ...str, readOnly: true, description: "Server-assigned; equals serviceId" },
    serviceId: id,
    access: {
      type: "string",
      enum: ["eligible", "ineligible", "exclusive"],
      description: "exclusive only for services without a retail price",
    },
    includedQuantity: { type: "integer", minimum: 0, maximum: 1000, default: 0 },
    period: {
      type: "object",
      nullable: true,
      required: ["unit"],
      properties: {
        unit: { type: "string", enum: ["year", "quarter", "month"] },
        anchor: { type: "string", enum: ["anniversary"] },
        rollover: { type: "string", enum: ["none"] },
      },
      description: "Required exactly when includedQuantity > 0",
    },
    exhaustion: { type: "string", enum: ["paid", "deny"], default: "paid" },
    pricing,
  },
};
const planFields = {
  slug,
  name: { type: "string", minLength: 1, maxLength: 120 },
  priceCents: { ...cents, nullable: true, description: "null = price not supplied" },
  billingTerm: { type: "string", enum: ["monthly", "quarterly", "annual"], nullable: true },
  status: { type: "string", enum: ["active", "archived"] },
  clinicianChat: bool,
  benefits: { type: "array", maxItems: 100, items: benefit },
};
const modifierFields = {
  slug: { ...slug, description: "Delivery method key; 'standard' is reserved" },
  name: { type: "string", minLength: 1, maxLength: 120 },
  amountCents: cents,
  serviceIds: {
    ...ids(100),
    minItems: 1,
    description: "Applies to these services and bundles containing them",
  },
  marketScope: { type: "string", enum: ["all", "listed"] },
  marketIds: ids(50),
  chargeWhenIncluded: {
    ...bool,
    description: "Charge even when the service is included; never discounted",
  },
  active: bool,
};
const objectOf = (props: Record<string, unknown>) => ({
  type: "object",
  properties: { ...props, ...stamped },
});
const createBody = (props: Record<string, unknown>, required: string[]) => ({
  type: "object",
  additionalProperties: false,
  required,
  properties: props,
});
const patchBody = (props: Record<string, unknown>) => {
  const { slug: Slug, ...rest } = props;
  return {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: { ...rest, expectedVersion },
  };
};
const allowance = {
  type: "object",
  nullable: true,
  properties: {
    membershipId: str,
    benefitId: str,
    limit: { type: "integer" },
    usedBefore: { type: "integer" },
    remainingAfter: { type: "integer" },
    consumes: { type: "integer", enum: [0, 1] },
    periodStart: { type: "string", format: "date-time" },
    periodEnd: { type: "string", format: "date-time", description: "Renewal date" },
  },
};
const quote = {
  type: "object",
  properties: {
    bookable: bool,
    denialReason: {
      type: "string",
      nullable: true,
      enum: [
        "SERVICE_NOT_FOUND",
        "SERVICE_INACTIVE",
        "MARKET_UNAVAILABLE",
        "DELIVERY_UNAVAILABLE",
        "NOT_ELIGIBLE",
        "ALLOWANCE_EXHAUSTED",
        "NOT_PURCHASABLE",
      ],
    },
    serviceId: str,
    marketId: { ...str, nullable: true },
    deliveryMethod: str,
    selection: {
      type: "object",
      nullable: true,
      properties: {
        membershipId: { ...str, nullable: true },
        planId: { ...str, nullable: true },
        benefitId: { ...str, nullable: true },
      },
    },
    decision: {
      type: "string",
      nullable: true,
      enum: ["allowance", "included", "episode_component", "custom", "discount", "retail"],
    },
    retailCents: { type: "integer", nullable: true },
    priceCents: { type: "integer", nullable: true },
    allowance,
    fees: {
      type: "array",
      items: {
        type: "object",
        properties: { modifierId: str, key: str, amountCents: { type: "integer" } },
      },
    },
    feesCents: { type: "integer" },
    finalCents: { type: "integer", nullable: true },
    currency: str,
    ruleVersion: str,
    quotedAt: { type: "string", format: "date-time" },
    expiresAt: { type: "string", format: "date-time" },
    candidates: { type: "array", items: { type: "object" } },
  },
};
const envelope = (data: unknown) => ({
  type: "object",
  required: ["success", "status", "message", "data", "statusCode"],
  properties: { success: bool, status: str, message: str, statusCode: { type: "integer" }, data },
});
const json = (description: string, schema: unknown) => ({
  description,
  content: { "application/json": { schema } },
});
const error = { $ref: "#/components/schemas/ErrorResponse" };
const op = (
  summary: string,
  data: unknown,
  extra: Record<string, unknown> = {},
  created = false
) => ({
  summary,
  tags: ["Catalog"],
  security: [{ staffBearer: [] }],
  responses: {
    [created ? 201 : 200]: json("Success", envelope(data)),
    400: json("Invalid input or references", error),
    401: json("Session expired", error),
    403: json("Permission denied", error),
    404: json("Not found in this organization", error),
    409: json("Slug taken or stale expectedVersion", error),
  },
  ...extra,
});
const body = (schema: unknown) => ({ required: true, content: { "application/json": { schema } } });
const pathId = [{ in: "path", name: "id", required: true, schema: id }];
const market = objectOf(marketFields);
const plan = objectOf(planFields);
const modifier = objectOf(modifierFields);

export const catalogPaths = {
  "/api/v1/markets": {
    get: op("List markets; SERVICES view", { type: "array", items: market }),
    post: op(
      "Create market; SYSTEM_SETTINGS edit",
      market,
      { requestBody: body(createBody(marketFields, ["slug", "name"])) },
      true
    ),
  },
  "/api/v1/markets/{id}": {
    patch: op("Update market; SYSTEM_SETTINGS edit", market, {
      parameters: pathId,
      requestBody: body(patchBody(marketFields)),
    }),
  },
  "/api/v1/membership-plans": {
    get: op("List client membership plans (legacy tier plans excluded); SERVICES view", {
      type: "array",
      items: plan,
    }),
    post: op(
      "Create membership plan with per-service benefits; BILLING edit",
      plan,
      { requestBody: body(createBody(planFields, ["slug", "name"])) },
      true
    ),
  },
  "/api/v1/membership-plans/{id}": {
    get: op("View membership plan; SERVICES view", plan, { parameters: pathId }),
    patch: op("Update plan; benefits array replaces the whole list; BILLING edit", plan, {
      parameters: pathId,
      requestBody: body(patchBody(planFields)),
    }),
  },
  "/api/v1/delivery-modifiers": {
    get: op("List delivery modifiers; SERVICES view", { type: "array", items: modifier }),
    post: op(
      "Create delivery modifier; BILLING edit",
      modifier,
      {
        requestBody: body(
          createBody(modifierFields, ["slug", "name", "amountCents", "serviceIds"])
        ),
      },
      true
    ),
  },
  "/api/v1/delivery-modifiers/{id}": {
    patch: op("Update delivery modifier; BILLING edit", modifier, {
      parameters: pathId,
      requestBody: body(patchBody(modifierFields)),
    }),
  },
  "/api/v1/catalog-revisions": {
    get: op(
      "Append-only configuration history, newest version first; SERVICES view",
      {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id,
                entityType: str,
                entityId: str,
                version: { type: "integer" },
                snapshot: { type: "object" },
                actorId: str,
                effectiveFrom: { type: "string", format: "date-time" },
                recordedAt: { type: "string", format: "date-time" },
              },
            },
          },
          pagination: { type: "object" },
        },
      },
      {
        parameters: [
          {
            in: "query",
            name: "entityType",
            required: true,
            schema: {
              type: "string",
              enum: ["service", "market", "membership_plan", "delivery_modifier"],
            },
          },
          { in: "query", name: "entityId", required: true, schema: id },
          { in: "query", name: "page", schema: { type: "integer", minimum: 1, default: 1 } },
          {
            in: "query",
            name: "limit",
            schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
        ],
      }
    ),
  },
  "/api/v1/entitlements/preview": {
    post: op(
      "What-if quote for hypothetical memberships; no member record, no ledger writes; SERVICES view",
      quote,
      {
        requestBody: body({
          type: "object",
          additionalProperties: false,
          required: ["serviceId", "at"],
          properties: {
            serviceId: id,
            marketId: { ...id, nullable: true },
            deliveryMethod: { type: "string", default: "standard" },
            at: { type: "string", format: "date-time", description: "Appointment time" },
            memberships: {
              type: "array",
              maxItems: 10,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["planId", "startedAt"],
                properties: { planId: id, startedAt: { type: "string", format: "date-time" } },
              },
            },
            usage: {
              type: "object",
              additionalProperties: { type: "integer", minimum: 0 },
              description: "Current-period units used, keyed '<planId>:<benefitId>'",
            },
          },
        }),
      }
    ),
  },
};
