import * as Sentry from "@sentry/node";
import { logger } from "../logger/logger";

let sentryEnabled = false;

export function initializeSentry(): boolean {
  const dsn = process.env.SENTRY_DSN;

  if (!dsn) {
    logger.info("Sentry DSN not configured; error capture is disabled");
    return false;
  }

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
    release: process.env.SENTRY_RELEASE
  });

  sentryEnabled = true;
  logger.info("Sentry initialized");
  return true;
}

export function captureError(error: unknown, context: Record<string, unknown>) {
  if (!sentryEnabled) {
    return;
  }

  Sentry.withScope((scope) => {
    for (const [key, value] of Object.entries(context)) {
      scope.setExtra(key, value);
    }

    Sentry.captureException(error);
  });
}

export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (sentryEnabled) {
    await Sentry.flush(timeoutMs);
  }
}
