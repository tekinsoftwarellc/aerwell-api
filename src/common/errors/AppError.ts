export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly data?: unknown;
  public readonly code?: string;

  constructor(
    message: string,
    statusCode = 500,
    isOperational = true,
    data?: unknown,
    code?: string
  ) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.data = data;
    this.code = code;

    Error.captureStackTrace(this, this.constructor);
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Bad Request", data?: unknown, code?: string) {
    super(message, 400, true, data, code);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized", code?: string) {
    super(message, 401, true, undefined, code);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden", code?: string) {
    super(message, 403, true, undefined, code);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found", code?: string) {
    super(message, 404, true, undefined, code);
  }
}

export class ConflictError extends AppError {
  constructor(message = "Resource already exists", data?: unknown, code?: string) {
    super(message, 409, true, data, code);
  }
}

export class ValidationError extends AppError {
  constructor(message = "Validation failed", code?: string) {
    super(message, 422, true, undefined, code);
  }
}

export class PaymentError extends AppError {
  constructor(message = "Payment required", data?: unknown, code?: string) {
    super(message, 402, true, data, code);
  }
}

export class InternalServerError extends AppError {
  constructor(message = "Internal server error", code?: string) {
    super(message, 500, true, undefined, code);
  }
}
