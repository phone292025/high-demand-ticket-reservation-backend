import "dotenv/config";
import { AppDataSource, initializeDataSource } from "./data-source";
import { createApp } from "./app";
import {
  createFirebaseAuthVerifier,
  getFirebaseMessagingOrUndefined
} from "./auth/firebase-admin";
import { registerGracefulShutdown } from "./operations/graceful-shutdown";
import { startNotificationWorker } from "./operations/notification-worker";
import { createRedisClient } from "./redis/redis-client";
import { logger } from "./logger/logger";
import { initializeSentry } from "./observability/sentry";
import { seedConcerts } from "./scripts/seed";
import {
  FirebaseNotificationSender,
  NotificationService
} from "./services/notification.service";

const port = Number(process.env.PORT ?? 3000);

async function bootstrap() {
  initializeSentry();
  await initializeDataSource(AppDataSource);
  logger.info("Database connected");

  if (process.env.RUN_MIGRATIONS_ON_START === "true") {
    const migrations = await AppDataSource.runMigrations();
    logger.info(
      {
        migrations: migrations.map((migration) => migration.name)
      },
      "Startup migrations completed"
    );
  }

  if (process.env.SEED_ON_START === "true") {
    const concerts = await seedConcerts(AppDataSource, { resetExisting: false });
    logger.info(
      { concertCount: concerts.length },
      "Startup seed completed without resetting existing stock"
    );
  }

  const shouldEnableRateLimit = process.env.ENABLE_RATE_LIMIT !== "false";
  const redisClient =
    shouldEnableRateLimit && process.env.REDIS_URL
      ? await createRedisClient()
      : undefined;

  if (shouldEnableRateLimit && !redisClient) {
    logger.warn(
      "REDIS_URL is not configured; using in-memory reservation rate limiting"
    );
  }

  const firebaseAuthVerifier = createFirebaseAuthVerifier();
  const firebaseMessaging = getFirebaseMessagingOrUndefined();
  const notificationService = new NotificationService(
    AppDataSource,
    firebaseMessaging ? new FirebaseNotificationSender(firebaseMessaging) : undefined
  );
  const notificationWorker = startNotificationWorker(notificationService);

  const app = createApp(AppDataSource, {
    enableRateLimit: shouldEnableRateLimit,
    redisClient,
    firebaseAuthVerifier,
    notificationService
  });

  const server = app.listen(port, () => {
    logger.info(`Ticket reservation API listening on http://localhost:${port}`);
  });

  registerGracefulShutdown({
    server,
    dataSource: AppDataSource,
    redisClient,
    waitMs: 5000,
    onShutdown: [() => notificationWorker.stop()]
  });
}

bootstrap().catch((error) => {
  logger.error({ error }, "Failed to start server");
  process.exit(1);
});
