const string = { type: "string" };
const tokenPair = {
  type: "object",
  required: ["accessToken", "refreshToken"],
  properties: { accessToken: string, refreshToken: string },
};
const envelope = (data: unknown) => ({
  type: "object",
  properties: {
    success: { type: "boolean" },
    status: string,
    message: string,
    statusCode: { type: "integer" },
    data,
  },
});
const response = (description: string, schema: unknown) => ({
  description,
  content: { "application/json": { schema } },
});
const error = { $ref: "#/components/schemas/ErrorResponse" };
function post(
  summary: string,
  properties: Record<string, unknown>,
  data: unknown,
  secured = false,
  status = 200
) {
  return {
    post: {
      summary,
      tags: ["Staff authentication"],
      ...(secured ? { security: [{ staffBearer: [] }] } : {}),
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: false,
              required: Object.keys(properties),
              properties,
            },
          },
        },
      },
      responses: {
        [status]: response("Success", envelope(data)),
        400: response("Invalid input", error),
        401: response("Invalid credentials or expired session/code", error),
        403: response("Staff access denied", error),
        423: response("Account temporarily locked", error),
        429: response("Rate limited", error),
        503: response("Authentication or email is not configured", error),
      },
    },
  };
}
function get(summary: string, data: unknown) {
  return {
    get: {
      summary,
      tags: ["Staff authentication"],
      security: [{ staffBearer: [] }],
      responses: {
        200: response("Success", envelope(data)),
        401: response("Session expired", error),
        403: response("Staff access denied", error),
      },
    },
  };
}
export const authPaths = {
  "/api/v1/auth/login": post(
    "Sign in with independent Aerwell staff credentials",
    { email: { type: "string", format: "email" }, password: { type: "string", maxLength: 72 } },
    {
      oneOf: [
        tokenPair,
        {
          type: "object",
          required: ["challenge", "challengeId"],
          properties: {
            challenge: { type: "string", enum: ["2FA_REQUIRED"] },
            challengeId: string,
          },
        },
      ],
    }
  ),
  "/api/v1/auth/refresh": post(
    "Rotate a local refresh token; replay revokes its session",
    { refreshToken: string },
    tokenPair
  ),
  "/api/v1/auth/logout": post(
    "Revoke the entire local session, including its access token",
    { refreshToken: string },
    { nullable: true }
  ),
  "/api/v1/auth/2fa/verify": post(
    "Consume a ten-minute email code; five attempts maximum",
    {
      challengeId: { type: "string", pattern: "^[a-f0-9]{24}$" },
      code: { type: "string", pattern: "^[0-9]{6}$" },
    },
    tokenPair
  ),
  "/api/v1/auth/forgot-password": post(
    "Request recovery; same response for every email",
    { email: { type: "string", format: "email" } },
    { nullable: true },
    false,
    202
  ),
  "/api/v1/auth/reset-password": post(
    "Consume a recovery link and revoke all staff sessions",
    { token: string, password: { type: "string", minLength: 12, maxLength: 72 } },
    { nullable: true }
  ),
  "/api/v1/auth/change-password": post(
    "Change own password and revoke all sessions",
    { currentPassword: string, password: { type: "string", minLength: 12, maxLength: 72 } },
    { nullable: true },
    true
  ),
  "/api/v1/me": get("Current staff profile, database permissions, organization and idle timeout", {
    type: "object",
    required: ["id", "firstName", "lastName", "permissions", "visibleModules", "organization"],
    properties: {
      id: string,
      firstName: string,
      lastName: string,
      email: string,
      roleLabel: string,
      avatarUrl: string,
      isSuperAdmin: { type: "boolean" },
      permissions: {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: {
            level: { type: "string", enum: ["none", "view", "edit", "master"] },
            scope: { type: "string", enum: ["own", "all"] },
          },
        },
      },
      visibleModules: { type: "array", items: string },
      organization: {
        type: "object",
        properties: { name: string, timeZone: string, logoUrl: string },
      },
      security: { type: "object", properties: { autoSignOutMinutes: { type: "integer" } } },
    },
  }),
  "/api/v1/me/counters": get(
    "Unread notification count (zero until notification producers are enabled)",
    { type: "object", properties: { unreadNotifications: { type: "integer" } } }
  ),
  "/api/v1/permissions/modules": get("The nine Aerwell permission modules", {
    type: "array",
    items: { type: "object", properties: { id: string, label: string } },
  }),
};
