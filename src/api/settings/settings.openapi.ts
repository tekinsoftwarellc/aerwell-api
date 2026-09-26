const error = { $ref: "#/components/schemas/ErrorResponse" };
const operation = (method: string, path: string) => ({
  summary: `${method.toUpperCase()} ${path}`,
  tags: ["Settings and staff"],
  security: [{ staffBearer: [] }],
  ...(path.includes("{")
    ? {
        parameters: [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
          name: match[1],
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^[a-f0-9]{24}$" },
        })),
      }
    : {}),
  responses: {
    200: { description: "Success envelope with data" },
    201: { description: "Created resource" },
    400: {
      description: "Invalid body, query or parameters",
      content: { "application/json": { schema: error } },
    },
    401: { description: "Staff session required" },
    403: { description: "Insufficient permissions or attempted permission escalation" },
    404: { description: "Record not found in organization or permitted scope" },
    409: { description: "Duplicate record" },
    422: { description: "Domain constraint (self/last-admin deactivation or incomplete upload)" },
    503: { description: "Required storage or email integration not configured" },
  },
});
// Explicit manifest: drift test compares this hand-maintained contract to actual Express mounts.
const paths: [string, string[]][] = [
  ["/settings/organization", ["get"]],
  ["/settings/organization/profile", ["patch"]],
  ["/settings/organization/regional", ["patch"]],
  ["/settings/organization/logo", ["post"]],
  ["/settings/security", ["get", "patch"]],
  ["/roles", ["get", "post"]],
  ["/roles/{id}", ["get", "patch"]],
  ["/me/notification-preferences", ["get", "put"]],
  ["/notification-rules", ["get", "post"]],
  ["/notification-rules/{id}", ["patch"]],
  ["/audit-events", ["get"]],
  ["/locations", ["get"]],
  ["/locations/{id}/environments", ["get"]],
  ["/invites", ["get", "post"]],
  ["/invites/{id}/resend", ["post"]],
  ["/invites/{id}/revoke", ["post"]],
  ["/auth/accept-invite", ["post"]],
  ["/staff", ["get", "post"]],
  ["/staff/roles", ["get"]],
  ["/staff/bulk/deactivate", ["post"]],
  ["/staff/{id}", ["get", "patch"]],
  ["/staff/{id}/activity", ["get"]],
  ["/staff/{id}/notes", ["post"]],
  ["/staff/{id}/flags", ["post"]],
  ["/staff/{id}/flags/{flagId}/resolve", ["post"]],
  ["/staff/{id}/employment", ["get", "patch"]],
  ["/staff/{id}/compensation", ["patch"]],
  ["/staff/{id}/permissions", ["get", "put"]],
  ["/staff/{id}/certifications", ["get", "post"]],
  ["/staff/{id}/certifications/{certId}", ["patch"]],
  ["/staff/{id}/deactivate", ["post"]],
  ["/uploads/presign", ["post"]],
  ["/staff/{id}/photo", ["get", "post"]],
  ["/staff/{id}/documents", ["get", "post"]],
  ["/staff/{id}/documents/{docId}", ["get"]],
];
export const settingsPaths = Object.fromEntries(
  paths.map(([path, methods]) => [
    `/api/v1${path}`,
    Object.fromEntries(methods.map((method) => [method, operation(method, path)])),
  ])
);
