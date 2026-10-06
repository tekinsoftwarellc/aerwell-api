const error = { $ref: "#/components/schemas/ErrorResponse" };
const operation = (method: string, path: string) => ({
  summary: `${method.toUpperCase()} ${path}`,
  tags: ["Alfred partner outbox"],
  security: [{ staffBearer: [] }],
  ...(path.includes("{")
    ? {
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", pattern: "^[a-f0-9]{24}$" },
          },
        ],
      }
    : {}),
  responses: {
    200: { description: "Success envelope with data" },
    400: {
      description: "Invalid query or parameters",
      content: { "application/json": { schema: error } },
    },
    401: { description: "Staff session required" },
    403: { description: "Insufficient permissions" },
    404: { description: "No failed or dead event with that id" },
  },
});
const paths: [string, string[]][] = [
  ["/partner-outbox", ["get"]],
  ["/partner-outbox/{id}/retry", ["post"]],
];
export const partnerOutboxPaths = Object.fromEntries(
  paths.map(([path, methods]) => [
    `/api/v1${path}`,
    Object.fromEntries(methods.map((method) => [method, operation(method, path)])),
  ])
);
