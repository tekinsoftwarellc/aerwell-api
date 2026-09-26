import { appointmentPaths } from "../api/appointment/appointment.openapi.js";
import { authPaths } from "../api/auth/auth.openapi.js";
import { catalogPaths } from "../api/catalog/catalog.openapi.js";
import { clinicalPaths } from "../api/clinical/clinical.openapi.js";
import { dashboardPaths } from "../api/dashboard/dashboard.openapi.js";
import { memberPaths } from "../api/member/member.openapi.js";
import { schedulePaths } from "../api/schedule/schedule.openapi.js";
import { servicePaths } from "../api/service/service.openapi.js";
import { settingsPaths } from "../api/settings/settings.openapi.js";
import { visitPaths } from "../api/visit/visit.openapi.js";
const envelope = (data: Record<string, unknown>) => ({
  type: "object",
  required: ["success", "status", "message", "data", "statusCode"],
  properties: {
    success: { type: "boolean", enum: [true] },
    status: { type: "string", enum: ["success"] },
    message: { type: "string" },
    data,
    statusCode: { type: "integer", example: 200 },
  },
});
const response = (description: string, schema: Record<string, unknown>) => ({
  description,
  content: { "application/json": { schema } },
});
export const swaggerSpec = {
  openapi: "3.0.3",
  info: { title: "Aerwell API", version: "0.1.0", description: "Aerwell staff API scaffold" },
  paths: {
    ...authPaths,
    ...settingsPaths,
    ...servicePaths,
    ...catalogPaths,
    ...schedulePaths,
    ...memberPaths,
    ...appointmentPaths,
    ...clinicalPaths,
    ...dashboardPaths,
    // W9 visit workspace (appended).
    ...visitPaths,
    "/api/v1/health": {
      get: {
        summary: "Process and Mongo health",
        tags: ["Health"],
        responses: {
          "200": response(
            "Current health",
            envelope({
              type: "object",
              properties: {
                status: { type: "string" },
                uptime: { type: "number" },
                timestamp: { type: "string", format: "date-time" },
                database: {
                  type: "object",
                  properties: {
                    status: { type: "string", enum: ["connected", "disconnected"] },
                    name: { type: "string" },
                  },
                },
              },
            })
          ),
        },
      },
    },
    "/api/v1/health/live": {
      get: {
        summary: "Process liveness",
        tags: ["Health"],
        responses: {
          "200": response(
            "Alive",
            envelope({ type: "object", properties: { alive: { type: "boolean" } } })
          ),
        },
      },
    },
    "/api/v1/health/ready": {
      get: {
        summary: "Database readiness",
        tags: ["Health"],
        responses: {
          "200": response(
            "Ready",
            envelope({ type: "object", properties: { ready: { type: "boolean" } } })
          ),
          "503": response("Database unavailable", { $ref: "#/components/schemas/ErrorResponse" }),
        },
      },
    },
  },
  components: {
    securitySchemes: { staffBearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
    schemas: {
      ErrorResponse: {
        type: "object",
        required: ["success", "status", "code", "message", "data", "statusCode"],
        properties: {
          success: { type: "boolean", enum: [false] },
          status: { type: "string", enum: ["error"] },
          code: { type: "string", example: "NOT_FOUND" },
          message: { type: "string" },
          data: { nullable: true },
          statusCode: { type: "integer", example: 404 },
        },
      },
    },
  },
};
