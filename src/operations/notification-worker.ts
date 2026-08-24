import type { NotificationService } from "../services/notification.service";
import { logger } from "../logger/logger";

export interface NotificationWorker {
  stop(): void;
}

export function startNotificationWorker(
  notificationService: NotificationService,
  intervalMs = 30 * 1000
): NotificationWorker {
  const timer = setInterval(() => {
    notificationService
      .processDueExpirationWarnings()
      .then((result) => {
        if (result.sentCount || result.skippedCount || result.failedCount) {
          logger.info(result, "Processed due ticket notifications");
        }
      })
      .catch((error) => {
        logger.error({ error }, "Ticket notification worker failed");
      });
  }, intervalMs);

  timer.unref();

  return {
    stop() {
      clearInterval(timer);
    }
  };
}
