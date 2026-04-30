import pino from "pino";
import { getCorrelationId } from "../context/request-context";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info"),
  base: undefined,
  mixin() {
    return {
      correlation_id: getCorrelationId()
    };
  }
});
