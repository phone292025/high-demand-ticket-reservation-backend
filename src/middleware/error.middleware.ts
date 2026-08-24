import type { ErrorRequestHandler } from "express";
import {
  OptimisticLockVersionMismatchError,
  QueryFailedError,
  EntityNotFoundError
} from "typeorm";
import { ZodError, z } from "zod";
import { getCorrelationId } from "../context/request-context";
import { AppError, ConcurrencyError } from "../errors/AppError";
import { logger } from "../logger/logger";
import { captureError } from "../observability/sentry";

/** SQLite write-contention codes that mean "retry", not "server broke". */
const CONTENTION_SQL_CODES = ["SQLITE_BUSY", "SQLITE_LOCKED"];

function isContentionError(error: QueryFailedError): boolean {
  const driverError = error.driverError as { code?: string } | undefined;
  const code = driverError?.code ?? "";
  return CONTENTION_SQL_CODES.some((contentionCode) =>
    code.includes(contentionCode)
  );
}

function mapError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof ZodError) {
    logger.warn(
      {
        error: "VALIDATION_ERROR",
        issues: z.flattenError(error)
      },
      "Validation error"
    );
    return new AppError(400, "VALIDATION_ERROR", "Invalid request body");
  }

  if (error instanceof SyntaxError && "body" in error) {
    return new AppError(400, "VALIDATION_ERROR", "Invalid JSON body", {
      cause: error
    });
  }

  // A lost race is an expected outcome of concurrent purchases, not a bug.
  // Reported as 500 it pages the on-call and pollutes Sentry.
  if (error instanceof OptimisticLockVersionMismatchError) {
    return new ConcurrencyError();
  }

  if (error instanceof QueryFailedError && isContentionError(error)) {
    return new ConcurrencyError(
      "The database is busy with another write. Please retry."
    );
  }

  if (error instanceof EntityNotFoundError) {
    return new AppError(404, "NOT_FOUND", "Resource not found", {
      cause: error
    });
  }

  return new AppError(500, "INTERNAL_ERROR", "Internal server error", {
    cause: error
  });
}

export const errorMiddleware: ErrorRequestHandler = (
  error,
  _request,
  response,
  _next
) => {
  const mappedError = mapError(error);
  const correlationId = getCorrelationId();

  // Expected 4xx outcomes are noise in Sentry; only report real faults.
  if (mappedError.statusCode >= 500) {
    captureError(error, {
      code: mappedError.code,
      correlationId,
      statusCode: mappedError.statusCode
    });
  }

  const logError = mappedError.statusCode >= 500 ? logger.error : logger.warn;
  logError.call(
    logger,
    {
      error: mappedError.code,
      statusCode: mappedError.statusCode,
      stack: error instanceof Error ? error.stack : undefined,
      cause:
        error instanceof AppError && error.cause instanceof Error
          ? error.cause.stack
          : undefined
    },
    "Global error handled"
  );

  response.status(mappedError.statusCode).json({
    error: mappedError.code,
    message: mappedError.userMessage,
    ref: correlationId
  });
};
