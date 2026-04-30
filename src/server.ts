import "dotenv/config";
import { AppDataSource, initializeDataSource } from "./data-source";
import { createApp } from "./app";
import { registerGracefulShutdown } from "./operations/graceful-shutdown";
import { createRedisClient } from "./redis/redis-client";
import { logger } from "./logger/logger";

const port = Number(process.env.PORT ?? 3000);

async function bootstrap() {
  await initializeDataSource(AppDataSource);
  logger.info("Database connected");

  const redisClient = await createRedisClient();
  const app = createApp(AppDataSource, {
    enableRateLimit: true,
    redisClient
  });

  const server = app.listen(port, () => {
    logger.info(`Ticket reservation API listening on http://localhost:${port}`);
  });

  registerGracefulShutdown({
    server,
    dataSource: AppDataSource,
    redisClient,
    waitMs: 5000
  });
}

bootstrap().catch((error) => {
  logger.error({ error }, "Failed to start server");
  process.exit(1);
});
