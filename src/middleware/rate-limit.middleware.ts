import type { Request } from "express";
import type { Options } from "express-rate-limit";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import type { RedisClientType } from "redis";
import { AppError } from "../errors/AppError";
import { logger } from "../logger/logger";
import type { FirebaseUser } from "../auth/firebase-config";

export interface RateLimiterOptions {
  redisClient?: RedisClientType;
  prefix?: string;
  windowMs?: number;
  limit?: number;
}

/**
 * Prefer the verified Firebase uid over the IP. IP alone throttles a whole
 * campus behind one NAT together while letting one client on a proxy pool
 * through unlimited. `ipKeyGenerator` normalises IPv6 into a /64 block.
 */
function authAwareKeyGenerator(request: Request): string {
  const authUser = (request as Request & { authUser?: FirebaseUser }).authUser;

  if (authUser?.uid) {
    return `uid:${authUser.uid}`;
  }

  return `ip:${ipKeyGenerator(request.ip ?? "")}`;
}

function createLimiter(
  name: string,
  message: string,
  {
    redisClient,
    prefix,
    windowMs,
    limit
  }: Required<Pick<RateLimiterOptions, "prefix">> & RateLimiterOptions
) {
  const limiterOptions: Partial<Options> = {
    windowMs: windowMs ?? 60 * 1000,
    limit: limit ?? 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: authAwareKeyGenerator,
    handler: (_request, _response, next) => {
      logger.warn({ error: "RATE_LIMITED", limiter: name }, "Rate limit exceeded");
      next(new AppError(429, "RATE_LIMITED", message));
    }
  };

  if (redisClient) {
    limiterOptions.store = new RedisStore({
      prefix,
      sendCommand: (...args: string[]) => redisClient.sendCommand(args)
    });
  }

  return rateLimit(limiterOptions);
}

export function createReservationRateLimiter(
  redisClient?: RedisClientType,
  prefix = "ticket-reserve-limit:"
) {
  return createLimiter(
    "reservation",
    "Too many reservation requests. Please try again later.",
    { redisClient, prefix, windowMs: 60 * 1000, limit: 5 }
  );
}

export function createPurchaseRateLimiter(
  redisClient?: RedisClientType,
  prefix = "ticket-purchase-limit:"
) {
  return createLimiter(
    "purchase",
    "Too many purchase requests. Please try again later.",
    { redisClient, prefix, windowMs: 60 * 1000, limit: 20 }
  );
}

/**
 * Front-door limiter. Runs before authentication so a flood of invalid tokens
 * cannot force a Firebase verification per request.
 */
export function createGlobalRateLimiter(
  redisClient?: RedisClientType,
  prefix = "ticket-global-limit:"
) {
  return createLimiter("global", "Too many requests. Please try again later.", {
    redisClient,
    prefix,
    windowMs: 60 * 1000,
    limit: 120
  });
}
