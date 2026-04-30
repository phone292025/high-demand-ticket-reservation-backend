import { randomUUID } from "node:crypto";
import { NextFunction, Request, Response } from "express";
import { runWithRequestContext } from "../context/request-context";

export const CORRELATION_ID_HEADER = "x-correlation-id";

export function correlationIdMiddleware(
  request: Request,
  response: Response,
  next: NextFunction
) {
  const incomingCorrelationId = request.header(CORRELATION_ID_HEADER);
  const correlationId =
    incomingCorrelationId && incomingCorrelationId.trim().length > 0
      ? incomingCorrelationId.trim()
      : randomUUID();

  response.setHeader("X-Correlation-ID", correlationId);

  runWithRequestContext({ correlationId }, () => {
    next();
  });
}
