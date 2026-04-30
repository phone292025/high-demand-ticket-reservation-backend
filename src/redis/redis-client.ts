import { createClient, RedisClientType } from "redis";
import { logger } from "../logger/logger";

export async function createRedisClient(): Promise<RedisClientType> {
  const redisClient = createClient({
    url: process.env.REDIS_URL ?? "redis://localhost:6379"
  });

  redisClient.on("error", (error) => {
    logger.error({ error: error.message }, "Redis client error");
  });

  await redisClient.connect();
  logger.info("Redis connected");
  return redisClient as RedisClientType;
}

export async function closeRedisClient(
  redisClient: RedisClientType | undefined
): Promise<void> {
  if (redisClient?.isOpen) {
    await redisClient.quit();
    logger.info("Redis closed");
  }
}
