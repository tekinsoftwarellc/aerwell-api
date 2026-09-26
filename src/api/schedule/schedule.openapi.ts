// Hand-maintained contract for W3 scheduling routes; the drift test compares it to Express mounts.
const error = { $ref: "#/components/schemas/ErrorResponse" };
const dateSchema = { type: "string", format: "date", example: "2027-01-08" };
const timeSchema = { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$", example: "08:00" };
const idSchema = { type: "string", pattern: "^[a-f0-9]{24}$" };
type Param = {
  name: string;
  schema: Record<string, unknown>;
  required?: boolean;
  description?: string;
};
const query = (params: Param[]) => params.map((p) => ({ in: "query", required: false, ...p }));
const shiftFields = {
  staffId: { ...idSchema, nullable: true, description: "Omit or null for an open shift" },
  date: { ...dateSchema, description: "Calendar date in the location time zone" },
  startTime: timeSchema,
  endTime: { ...timeSchema, description: "Same-day end, after startTime" },
  positionRoleId: idSchema,
  locationId: idSchema,
  stationName: { type: "string", maxLength: 100, nullable: true, example: "Front Desk" },
};
const shiftBody = {
  type: "object",
  additionalProperties: false,
  required: ["date", "startTime", "endTime", "positionRoleId", "locationId"],
  properties: shiftFields,
};
const ptoBody = {
  type: "object",
  additionalProperties: false,
  required: ["startDate", "endDate", "type"],
  properties: {
    startDate: dateSchema,
    endDate: { ...dateSchema, description: "Inclusive; at most 366 days after startDate" },
    type: { type: "string", enum: ["vacation", "sick", "personal", "other"] },
    note: { type: "string", maxLength: 2000 },
  },
};
const availabilityBody = {
  type: "object",
  additionalProperties: false,
  required: ["days"],
  properties: {
    days: {
      type: "array",
      minItems: 7,
      maxItems: 7,
      items: {
        type: "object",
        required: ["weekday", "available"],
        properties: {
          weekday: { type: "integer", minimum: 0, maximum: 6, description: "0 = Sunday" },
          available: { type: "boolean" },
          start: timeSchema,
          end: timeSchema,
        },
      },
    },
  },
};
const onboardingBody = {
  type: "object",
  additionalProperties: false,
  required: ["steps"],
  properties: {
    steps: {
      type: "array",
      minItems: 2,
      maxItems: 2,
      items: {
        type: "object",
        required: ["key", "complete"],
        properties: {
          key: { type: "string", enum: ["paperwork", "training"] },
          complete: { type: "boolean" },
        },
      },
    },
  },
};
const decisionBody = {
  type: "object",
  additionalProperties: false,
  properties: { reason: { type: "string", maxLength: 1000 } },
};
const responses = {
  200: { description: "Success envelope with data" },
  201: { description: "Created resource" },
  400: {
    description: "Invalid body, query or parameters",
    content: { "application/json": { schema: error } },
  },
  401: { description: "Staff session required" },
  403: { description: "Insufficient STAFF_RECORDS permission, or deciding your own time off" },
  404: { description: "Record not found in organization or permitted scope" },
  409: {
    description:
      "SHIFT_OVERLAP, SHIFT_DURING_PTO, SHIFT_STAFF_INACTIVE, PTO_OVERLAP, PTO_BALANCE_EXCEEDED or PTO_ALREADY_DECIDED",
  },
  422: {
    description:
      "INVALID_LOCAL_TIME (missing/ambiguous local time at a clock change) or PTO_IN_PAST",
  },
};
function operation(
  summary: string,
  path: string,
  extra: { query?: Param[]; body?: Record<string, unknown>; permission: string }
) {
  const pathParams = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => ({
    name: m[1],
    in: "path",
    required: true,
    schema: idSchema,
  }));
  return {
    summary,
    description: `Permission: ${extra.permission}. Times are stored UTC and computed in the location time zone.`,
    tags: ["Staff scheduling"],
    security: [{ staffBearer: [] }],
    parameters: [...pathParams, ...query(extra.query ?? [])],
    ...(extra.body
      ? { requestBody: { required: true, content: { "application/json": { schema: extra.body } } } }
      : {}),
    responses,
  };
}
const VIEW = "STAFF_RECORDS view (own scope limits results to self)";
const EDIT = "STAFF_RECORDS edit";
const scheduleParams: Param[] = [
  { name: "date", schema: dateSchema, required: true },
  { name: "view", schema: { type: "string", enum: ["day", "week", "month"], default: "day" } },
  { name: "staffId", schema: idSchema },
  { name: "roleIds", schema: { type: "array", items: idSchema } },
  { name: "q", schema: { type: "string", maxLength: 100 } },
];
const v1 = (path: string) => `/api/v1${path}`;
export const schedulePaths = {
  [v1("/staff/shifts")]: {
    get: operation("List shifts for a day, Monday-first week or month", "/staff/shifts", {
      query: scheduleParams,
      permission: VIEW,
    }),
    post: operation("Create a shift (open when staffId is omitted)", "/staff/shifts", {
      body: shiftBody,
      permission: EDIT,
    }),
  },
  [v1("/staff/shifts/{id}")]: {
    patch: operation("Update a shift", "/staff/shifts/{id}", {
      body: { ...shiftBody, required: [], minProperties: 1 },
      permission: EDIT,
    }),
    delete: operation("Delete a shift", "/staff/shifts/{id}", { permission: EDIT }),
  },
  [v1("/staff/coverage")]: {
    get: operation("Open shifts (uncovered windows) on a date", "/staff/coverage", {
      query: [{ name: "date", schema: dateSchema, required: true }],
      permission: VIEW,
    }),
  },
  [v1("/staff/pto-requests")]: {
    get: operation("List time-off requests ordered by start date", "/staff/pto-requests", {
      query: [
        { name: "status", schema: { type: "string", enum: ["pending", "approved", "denied"] } },
      ],
      permission: VIEW,
    }),
    post: operation("Request time off for yourself", "/staff/pto-requests", {
      body: ptoBody,
      permission: "any signed-in staff member (self only)",
    }),
  },
  [v1("/staff/pto-requests/{id}")]: {
    get: operation(
      "Request detail with balance before/after, affected shifts and coverage conflicts",
      "/staff/pto-requests/{id}",
      { permission: VIEW }
    ),
  },
  [v1("/staff/pto-requests/{id}/approve")]: {
    post: operation(
      "Approve: deducts balance and turns affected shifts into open shifts",
      "/staff/pto-requests/{id}/approve",
      { body: decisionBody, permission: `${EDIT}; never your own request` }
    ),
  },
  [v1("/staff/pto-requests/{id}/deny")]: {
    post: operation("Deny a pending request", "/staff/pto-requests/{id}/deny", {
      body: decisionBody,
      permission: `${EDIT}; never your own request`,
    }),
  },
  [v1("/staff/onboarding")]: {
    get: operation("New hires with incomplete onboarding", "/staff/onboarding", {
      permission: VIEW,
    }),
  },
  [v1("/staff/overview")]: {
    get: operation("Priorities, day schedule, pending PTO and onboarding", "/staff/overview", {
      query: [
        {
          name: "date",
          schema: dateSchema,
          description: "Defaults to today in the organization zone",
        },
      ],
      permission: VIEW,
    }),
  },
  [v1("/staff/providers")]: {
    get: operation("Active providers for pickers", "/staff/providers", { permission: VIEW }),
  },
  [v1("/staff/{id}/shifts")]: {
    get: operation("One staff member's month with totalHours", "/staff/{id}/shifts", {
      query: [{ name: "month", schema: { type: "string", example: "2027-01" }, required: true }],
      permission: VIEW,
    }),
  },
  [v1("/staff/{id}/availability")]: {
    get: operation("Weekly availability template", "/staff/{id}/availability", {
      permission: VIEW,
    }),
    put: operation("Replace weekly availability", "/staff/{id}/availability", {
      body: availabilityBody,
      permission: EDIT,
    }),
  },
  [v1("/staff/{id}/time-off")]: {
    get: operation("Balance, requests and upcoming leave for a year", "/staff/{id}/time-off", {
      query: [{ name: "year", schema: { type: "integer", minimum: 2000, maximum: 2099 } }],
      permission: VIEW,
    }),
  },
  [v1("/staff/{id}/onboarding")]: {
    patch: operation("Save onboarding checklist", "/staff/{id}/onboarding", {
      body: onboardingBody,
      permission: EDIT,
    }),
  },
};
