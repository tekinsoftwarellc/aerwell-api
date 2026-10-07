const idParam = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", pattern: "^[a-fA-F0-9]{24}$" },
};
const STAFF = [{ staffBearer: [] }];
const responses = (permission: string, extra: Record<string, unknown> = {}) => ({
  200: { description: "Success envelope" },
  400: { description: "VALIDATION_ERROR" },
  401: { description: "Staff session required" },
  403: { description: `Missing ${permission} permission` },
  ...extra,
});
const body = (properties: Record<string, unknown>, required: string[] = []) => ({
  required: true,
  content: { "application/json": { schema: { type: "object", properties, required } } },
});
const productFields = {
  name: { type: "string", maxLength: 200 },
  brand: { type: "string", nullable: true },
  size: { type: "string", nullable: true },
  description: { type: "string", maxLength: 4000 },
  priceCents: { type: "integer", minimum: 0, description: "Tax-inclusive" },
  stock: { type: "integer", minimum: 0, description: "Units on hand; a stocktake sets it" },
  weightGrams: { type: "integer", minimum: 0, nullable: true },
  forSale: { type: "boolean", description: "Published to Alfred as a catalog product" },
  imageUploadId: { type: "string", description: "From POST /services/images/presign" },
};
const orderOp = (summary: string, extra: Record<string, unknown> = {}) => ({
  summary,
  tags: ["Product orders"],
  security: STAFF,
  parameters: [idParam],
  responses: responses("BILLING edit", {
    404: { description: "Order not found" },
    409: { description: "ALREADY_SHIPPED, ORDER_NOT_PAID or NOT_SHIPPED" },
  }),
  ...extra,
});

export const productPaths: Record<string, Record<string, unknown>> = {
  "/api/v1/products": {
    get: {
      summary: "Product catalog with stock, including inactive items (SERVICES view)",
      tags: ["Products"],
      security: STAFF,
      responses: responses("SERVICES view"),
    },
    post: {
      summary:
        "Create a product {sku, name, priceCents, stock?, forSale?, ...} (SERVICES edit). A sellable product is published to Alfred as catalog kind products. Orderable only by a member a clinician prescribed it to.",
      tags: ["Products"],
      security: STAFF,
      requestBody: body(
        { sku: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,59}$" }, ...productFields },
        ["sku", "name", "priceCents"]
      ),
      responses: responses("SERVICES edit", {
        201: { description: "Created" },
        409: { description: "SKU_EXISTS" },
      }),
    },
  },
  "/api/v1/products/{id}": {
    patch: {
      summary: "Edit a product (SERVICES edit); `active: false` retires it. SKU is never changed.",
      tags: ["Products"],
      security: STAFF,
      parameters: [idParam],
      requestBody: body({
        ...productFields,
        active: { type: "boolean" },
        expectedStock: {
          type: "integer",
          minimum: 0,
          description: "With stock: apply only if stock still equals this, else 409 STOCK_CHANGED",
        },
      }),
      responses: responses("SERVICES edit", {
        404: { description: "Product not found" },
        409: { description: "STOCK_CHANGED" },
      }),
    },
  },
  "/api/v1/product-orders": {
    get: {
      summary:
        "Product orders for fulfilment, newest first, with the shipping address (BILLING view). The read is audited.",
      tags: ["Product orders"],
      security: STAFF,
      parameters: [
        {
          name: "status",
          in: "query",
          schema: {
            type: "string",
            enum: ["placed", "paid", "shipped", "delivered", "cancelled", "refunded"],
          },
        },
        { name: "page", in: "query", schema: { type: "integer", minimum: 1 } },
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
      ],
      responses: responses("BILLING view"),
    },
  },
  "/api/v1/product-orders/{id}/ship": {
    post: orderOp(
      "Mark a paid order shipped with tracking {carrier, number, url?} (BILLING edit); tells Alfred (order.shipped)",
      {
        requestBody: body(
          {
            carrier: { type: "string" },
            number: { type: "string" },
            url: { type: "string", format: "uri" },
          },
          ["carrier", "number"]
        ),
      }
    ),
  },
  "/api/v1/product-orders/{id}/deliver": {
    post: orderOp("Mark a shipped order delivered (BILLING edit); tells Alfred (order.delivered)"),
  },
  "/api/v1/product-orders/{id}/cancel": {
    post: orderOp(
      "Cancel a placed or paid order before it ships (BILLING edit); stock returns and Alfred refunds (order.cancelled)"
    ),
  },
  "/api/v1/public/product-images/{sku}": {
    get: {
      summary: "Public: redirect to a short-lived signed URL of a sellable product's image",
      tags: ["Products"],
      parameters: [
        {
          name: "sku",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,59}$" },
        },
        {
          name: "v",
          in: "query",
          required: false,
          description: "Cache buster; changes when the image is replaced",
          schema: { type: "string", pattern: "^[\\w-]{1,64}$" },
        },
      ],
      responses: {
        "302": { description: "Presigned S3 GET valid 300 s; Cache-Control public, max-age=240" },
        "400": { description: "Invalid sku or query" },
        "404": { description: "No sellable product with an image" },
      },
    },
  },
};
