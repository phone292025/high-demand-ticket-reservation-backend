import { Server } from "node:http";
import { DataSource } from "typeorm";
import { RedisClientType } from "redis";
import { closeRedisClient } from "../redis/redis-client";
import { logger } from "../logger/logger";
import { flushSentry } from "../observability/sentry";

export interface GracefulShutdownOptions {
  server: Server;
  dataSource: DataSource;
  redisClient?: RedisClientType;
  waitMs?: number;
  onShutdown?: Array<() => void | Promise<void>>;
}

export function registerGracefulShutdown({
  server,
  dataSource,
  redisClient,
  waitMs = 5000,
  onShutdown = []
}: GracefulShutdownOptions) {
  process.on("SIGTERM", async () => {
    logger.info("SIGTERM received");

    server.close(async () => {
      logger.info("Server stopped accepting new requests");
      await new Promise((resolve) => setTimeout(resolve, waitMs));

      if (dataSource.isInitialized) {
        await dataSource.destroy();
        logger.info("Database closed");
      }

      await closeRedisClient(redisClient);
      for (const shutdownTask of onShutdown) {
        await shutdownTask();
      }
      await flushSentry();
      logger.info("Graceful shutdown complete");
      process.exit(0);
    });
  });
}
