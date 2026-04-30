import { NextFunction, Request, Response } from "express";
import { logger } from "../logger/logger";

export function requestLoggerMiddleware(
  request: Request,
  response: Response,
  next: NextFunction
) {
  logger.info(
    {
      method: request.method,
      path: request.path
    },
    "Request received"
  );

  response.on("finish", () => {
    logger.info(
      {
        method: request.method,
        path: request.path,
        statusCode: response.statusCode
      },
      "Request completed"
    );
  });

  next();
}
