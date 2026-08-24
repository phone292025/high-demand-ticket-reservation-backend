import "dotenv/config";
import { AppDataSource, initializeDataSource } from "./data-source";
import { createApp } from "./app";
import {
  createFirebaseAuthVerifier,
  getFirebaseMessagingOrUndefined
} from "./auth/firebase-admin";
import { registerGracefulShutdown } from "./operations/graceful-shutdown";
import { startCleanupWorker } from "./operations/cleanup-worker";
import { startNotificationWorker } from "./operations/notification-worker";
import { createRedisClient } from "./redis/redis-client";
import { logger } from "./logger/logger";
import { initializeSentry } from "./observability/sentry";
import { seedConcerts } from "./scripts/seed";
import { CleanupService } from "./services/cleanup.service";
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

  const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 0);

  if (shouldEnableRateLimit && trustProxyHops === 0) {
    logger.warn(
      "TRUST_PROXY_HOPS is 0; if this runs behind a proxy, every client will " +
        "share one rate-limit bucket. Set it to the number of proxy hops."
    );
  }

  const firebaseAuthVerifier = createFirebaseAuthVerifier();
  const firebaseMessaging = getFirebaseMessagingOrUndefined();
  const notificationService = new NotificationService(
    AppDataSource,
    firebaseMessaging
      ? new FirebaseNotificationSender(firebaseMessaging)
      : undefined
  );
  const notificationWorker = startNotificationWorker(notificationService);

  const cleanupWorker = startCleanupWorker(new CleanupService(AppDataSource));

  const app = createApp(AppDataSource, {
    enableRateLimit: shouldEnableRateLimit,
    redisClient,
    firebaseAuthVerifier,
    notificationService,
    trustProxy: trustProxyHops
  });

  const server = app.listen(port, () => {
    logger.info(`Ticket reservation API listening on http://localhost:${port}`);
  });

  registerGracefulShutdown({
    server,
    dataSource: AppDataSource,
    redisClient,
    waitMs: 5000,
    onShutdown: [() => notificationWorker.stop(), () => cleanupWorker.stop()]
  });
}

bootstrap().catch((error) => {
  logger.error({ error }, "Failed to start server");
  process.exit(1);
});
