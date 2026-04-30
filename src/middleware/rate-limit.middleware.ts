import rateLimit from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { RedisClientType } from "redis";
import { AppError } from "../errors/AppError";
import { logger } from "../logger/logger";

export function createReservationRateLimiter(
  redisClient: RedisClientType,
  prefix = "ticket-reserve-limit:"
) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    store: new RedisStore({
      prefix,
      sendCommand: (...args: string[]) => redisClient.sendCommand(args)
    }),
    handler: (_request, _response, next) => {
      logger.warn({ error: "RATE_LIMITED" }, "Rate limit exceeded");
      next(
        new AppError(
          429,
          "RATE_LIMITED",
          "Too many reservation requests. Please try again later."
        )
      );
    }
  });
}
