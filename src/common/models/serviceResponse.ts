export const defaultErrorCode = (status: number): string =>
  ({
    400: "VALIDATION_ERROR",
    401: "UNAUTHORIZED",
    402: "PAYMENT_REQUIRED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    409: "CONFLICT",
    413: "PAYLOAD_TOO_LARGE",
    422: "VALIDATION_ERROR",
    429: "RATE_LIMITED",
    500: "INTERNAL_ERROR",
    503: "SERVICE_UNAVAILABLE",
  })[status] ?? (status >= 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR");

export enum ResponseStatus {
  Success = "success",
  Error = "error",
}

export interface ServiceResponse<T = null> {
  readonly success: boolean;
  readonly status: ResponseStatus;
  readonly message: string;
  readonly data: T;
  readonly statusCode: number;
  readonly code?: string;
}

function make<T>(
  status: ResponseStatus,
  message: string,
  data: T,
  statusCode: number,
  code?: string
): ServiceResponse<T> {
  return {
    success: status === ResponseStatus.Success,
    status,
    message,
    data,
    statusCode,
    ...(status === ResponseStatus.Error ? { code: code ?? defaultErrorCode(statusCode) } : {}),
  };
}

export const ServiceResponse = {
  success<T>(message: string, data: T, statusCode = 200): ServiceResponse<T> {
    return make(ResponseStatus.Success, message, data, statusCode);
  },

  error(
    message: string,
    data: unknown = null,
    statusCode = 500,
    code?: string
  ): ServiceResponse<unknown> {
    return make(ResponseStatus.Error, message, data, statusCode, code);
  },

  notFound(message = "Resource not found"): ServiceResponse<null> {
    return make(ResponseStatus.Error, message, null, 404);
  },

  badRequest<T = null>(message: string, data: T = null as T): ServiceResponse<T> {
    return make(ResponseStatus.Error, message, data, 400);
  },

  unauthorized(message = "Unauthorized"): ServiceResponse<null> {
    return make(ResponseStatus.Error, message, null, 401);
  },

  forbidden(message = "Forbidden"): ServiceResponse<null> {
    return make(ResponseStatus.Error, message, null, 403);
  },
};
