import { NextFunction, Request, Response } from "express";
import { ZodSchema, z } from "zod";
import { AppError } from "../errors/AppError";
import { logger } from "../logger/logger";

export function validateBody<T>(schema: ZodSchema<T>) {
  return (request: Request, _response: Response, next: NextFunction) => {
    const parseResult = schema.safeParse(request.body);

    if (!parseResult.success) {
      logger.warn(
        {
          error: "VALIDATION_ERROR",
          issues: z.flattenError(parseResult.error)
        },
        "Validation error"
      );
      next(new AppError(400, "VALIDATION_ERROR", "Invalid request body"));
      return;
    }

    request.body = parseResult.data;
    next();
  };
}
