import type { Server } from "node:http";
import type { DataSource } from "typeorm";
import type { RedisClientType } from "redis";
import { closeRedisClient } from "../redis/redis-client";
import { logger } from "../logger/logger";
import { flushSentry } from "../observability/sentry";

export interface GracefulShutdownOptions {
  server: Server;
  dataSource: DataSource;
  redisClient?: RedisClientType;
  waitMs?: number;
  /** Force-exit budget for the whole sequence. */
  forceExitMs?: number;
  onShutdown?: Array<() => void | Promise<void>>;
}

export const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];

export function registerGracefulShutdown({
  server,
  dataSource,
  redisClient,
  waitMs = 5000,
  forceExitMs = 15000,
  onShutdown = []
}: GracefulShutdownOptions) {
  let shuttingDown = false;

  async function shutdown(signal: NodeJS.Signals) {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info({ signal }, "Shutdown signal received");

    // server.close never fires while a keep-alive connection is open.
    const forceExitTimer = setTimeout(() => {
      logger.error("Graceful shutdown timed out; forcing exit");
      process.exit(1);
    }, forceExitMs);
    forceExitTimer.unref();

    try {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
      });
      logger.info("Server stopped accepting new requests");

      await new Promise((resolve) => setTimeout(resolve, waitMs));

      // Workers first, so no tick outlives the DataSource.
      for (const shutdownTask of onShutdown) {
        await shutdownTask();
      }

      await closeRedisClient(redisClient);

      if (dataSource.isInitialized) {
        await dataSource.destroy();
        logger.info("Database closed");
      }

      await flushSentry();
      logger.info("Graceful shutdown complete");
      clearTimeout(forceExitTimer);
      process.exit(0);
    } catch (error) {
      logger.error({ error }, "Graceful shutdown failed");
      clearTimeout(forceExitTimer);
      process.exit(1);
    }
  }

  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  // Node terminates on these by default; shut down in order instead.
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "Unhandled promise rejection; shutting down");
    void shutdown("SIGTERM");
  });

  process.on("uncaughtException", (error) => {
    logger.error({ error }, "Uncaught exception; shutting down");
    void shutdown("SIGTERM");
  });
}
