import { ErrorRequestHandler } from "express";
import { ZodError, z } from "zod";
import { getCorrelationId } from "../context/request-context";
import { AppError } from "../errors/AppError";
import { logger } from "../logger/logger";

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

  logger.error(
    {
      error: mappedError.code,
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
