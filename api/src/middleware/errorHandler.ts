import { Request, Response, NextFunction } from "express";
import pino from "pino";

const logger = pino();

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found") {
    super(404, "NOT_FOUND", message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(401, "UNAUTHORIZED", message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(403, "FORBIDDEN", message);
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict") {
    super(409, "CONFLICT", message);
  }
}

export class ValidationError extends AppError {
  constructor(message = "Validation failed") {
    super(400, "VALIDATION_ERROR", message);
  }
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      ok: false,
      error: {
        code: err.code,
        message: err.message,
        requestId: req.id,
      },
    });
    return;
  }

  if (isRequestBodyError(err)) {
    const tooLarge = err.type === "entity.too.large";
    res.status(tooLarge ? 413 : 400).json({
      ok: false,
      error: {
        code: tooLarge ? "PAYLOAD_TOO_LARGE" : "INVALID_REQUEST_BODY",
        message: tooLarge ? "Request body is too large" : "Request body must be valid JSON",
        requestId: req.id,
      },
    });
    return;
  }

  // Unique-constraint violations are races that lost, not server faults — the database-level
  // guards (one active proposal per document, one version number per document) land here.
  if (isUniqueConstraintError(err)) {
    logger.warn({ err, requestId: req.id }, "Unique constraint violation");
    res.status(409).json({
      ok: false,
      error: {
        code: "CONFLICT",
        message: "This change conflicts with another change that was just saved. Reload and try again.",
        requestId: req.id,
      },
    });
    return;
  }

  logger.error({ err, requestId: req.id }, "Unhandled error");

  res.status(500).json({
    ok: false,
    error: {
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
      requestId: req.id,
    },
  });
}

function isUniqueConstraintError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as { code?: unknown }).code === "P2002";
}

function isRequestBodyError(err: unknown): err is { type: string } {
  if (!err || typeof err !== "object") return false;
  const candidate = err as { type?: unknown };
  return candidate.type === "entity.too.large" || candidate.type === "entity.parse.failed";
}
