import type { CleanupService } from "../services/cleanup.service";
import { logger } from "../logger/logger";

export interface CleanupWorker {
  stop(): void;
}

export const DEFAULT_CLEANUP_INTERVAL_MS = 30 * 1000;

/** Sweeps expired reservations so their stock is released. */
export function startCleanupWorker(
  cleanupService: CleanupService,
  intervalMs = DEFAULT_CLEANUP_INTERVAL_MS
): CleanupWorker {
  const timer = setInterval(() => {
    cleanupService
      .cleanupExpiredReservations()
      .then((result) => {
        if (result.expiredCount > 0) {
          logger.info(result, "Released stock from expired reservations");
        }
      })
      .catch((error) => {
        logger.error({ error }, "Reservation cleanup worker failed");
      });
  }, intervalMs);

  timer.unref();

  return {
    stop() {
      clearInterval(timer);
    }
  };
}
