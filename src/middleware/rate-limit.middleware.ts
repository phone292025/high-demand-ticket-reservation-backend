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

/** Key on the verified uid when present, otherwise the normalised IP. */
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

/** Base namespace; each limiter appends its own segment. */
export const DEFAULT_RATE_LIMIT_PREFIX = "ticket-rate-limit:";

/** Namespaces one limiter under the shared base so counters never collide. */
export function rateLimitPrefix(basePrefix: string, limiterName: string): string {
  return `${basePrefix}${limiterName}:`;
}

export function createReservationRateLimiter(
  redisClient?: RedisClientType,
  basePrefix = DEFAULT_RATE_LIMIT_PREFIX
) {
  return createLimiter(
    "reservation",
    "Too many reservation requests. Please try again later.",
    {
      redisClient,
      prefix: rateLimitPrefix(basePrefix, "reserve"),
      windowMs: 60 * 1000,
      limit: 5
    }
  );
}

export function createPurchaseRateLimiter(
  redisClient?: RedisClientType,
  basePrefix = DEFAULT_RATE_LIMIT_PREFIX
) {
  return createLimiter(
    "purchase",
    "Too many purchase requests. Please try again later.",
    {
      redisClient,
      prefix: rateLimitPrefix(basePrefix, "purchase"),
      windowMs: 60 * 1000,
      limit: 20
    }
  );
}

/** Front-door limiter, applied before authentication. */
export function createGlobalRateLimiter(
  redisClient?: RedisClientType,
  basePrefix = DEFAULT_RATE_LIMIT_PREFIX
) {
  return createLimiter("global", "Too many requests. Please try again later.", {
    redisClient,
    prefix: rateLimitPrefix(basePrefix, "global"),
    windowMs: 60 * 1000,
    limit: 120
  });
}
