import type { CleanupService } from "../services/cleanup.service";
import { logger } from "../logger/logger";

export interface CleanupWorker {
  stop(): void;
}

export const DEFAULT_CLEANUP_INTERVAL_MS = 30 * 1000;

/**
 * Without this, an abandoned reservation holds its stock forever: the row stays
 * PENDING past `expiresAt` and the seats are never resold. The HTTP /cleanup
 * route is kept for manual runs, but it is disabled in production by default,
 * so the sweep has to be scheduled here.
 */
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
