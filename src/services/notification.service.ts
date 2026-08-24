import type { DataSource } from "typeorm";
import { In, LessThan, LessThanOrEqual } from "typeorm";
import type { Messaging } from "firebase-admin/messaging";
import { FcmToken } from "../entities/FcmToken";
import { Ticket } from "../entities/Ticket";
import {
  TicketNotification,
  TicketNotificationStatus
} from "../entities/TicketNotification";
import { TicketStatus } from "../entities/TicketStatus";
import { logger } from "../logger/logger";

export interface NotificationSendPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface NotificationSendResult {
  successCount: number;
  failureCount: number;
  /** Tokens FCM rejected as permanently invalid; safe to delete. */
  invalidTokens: string[];
}

export interface NotificationSender {
  sendToTokens(
    tokens: string[],
    payload: NotificationSendPayload
  ): Promise<NotificationSendResult>;
}

export interface DueNotificationResult {
  sentCount: number;
  skippedCount: number;
  failedCount: number;
}

const EXPIRES_SOON_LEAD_MS = 60 * 1000;

/** Retries left before a failed notification is abandoned. */
export const MAX_NOTIFICATION_ATTEMPTS = 3;

/** Cap on stored FCM registrations per user; oldest are evicted first. */
export const MAX_FCM_TOKENS_PER_USER = 10;

/**
 * FCM error codes that mean the token will never work again, as opposed to a
 * transient delivery failure worth retrying.
 */
const PERMANENT_TOKEN_ERROR_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument"
]);

export class FirebaseNotificationSender implements NotificationSender {
  constructor(private readonly messaging: Messaging) {}

  async sendToTokens(
    tokens: string[],
    payload: NotificationSendPayload
  ): Promise<NotificationSendResult> {
    if (tokens.length === 0) {
      return { successCount: 0, failureCount: 0, invalidTokens: [] };
    }

    const response = await this.messaging.sendEachForMulticast({
      tokens,
      notification: {
        title: payload.title,
        body: payload.body
      },
      data: payload.data
    });

    const invalidTokens: string[] = [];

    response.responses.forEach((tokenResponse, index) => {
      if (tokenResponse.success) {
        return;
      }

      const errorCode = tokenResponse.error?.code;
      if (errorCode && PERMANENT_TOKEN_ERROR_CODES.has(errorCode)) {
        invalidTokens.push(tokens[index]);
      }
    });

    return {
      successCount: response.successCount,
      failureCount: response.failureCount,
      invalidTokens
    };
  }
}

export class NotificationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly sender?: NotificationSender
  ) {}

  async registerFcmToken(userId: string, token: string): Promise<FcmToken> {
    const tokenRepository = this.dataSource.getRepository(FcmToken);
    const trimmedToken = token.trim();
    const existingToken = await tokenRepository.findOne({
      where: { token: trimmedToken }
    });

    if (existingToken) {
      existingToken.userId = userId;
      return tokenRepository.save(existingToken);
    }

    const savedToken = await tokenRepository.save(
      tokenRepository.create({
        userId,
        token: trimmedToken
      })
    );

    await this.evictOldestTokensOverLimit(userId);
    return savedToken;
  }

  async unregisterFcmToken(userId: string, token: string): Promise<void> {
    const tokenRepository = this.dataSource.getRepository(FcmToken);
    await tokenRepository.delete({
      userId,
      token: token.trim()
    });
  }

  /**
   * A user cycling browsers or reinstalling the PWA accumulates registrations
   * forever otherwise; every stale one costs a wasted send on each reminder.
   */
  private async evictOldestTokensOverLimit(userId: string): Promise<void> {
    const tokenRepository = this.dataSource.getRepository(FcmToken);
    const tokens = await tokenRepository.find({
      where: { userId },
      order: { id: "DESC" }
    });

    if (tokens.length <= MAX_FCM_TOKENS_PER_USER) {
      return;
    }

    const staleTokenIds = tokens
      .slice(MAX_FCM_TOKENS_PER_USER)
      .map((token) => token.id);

    await tokenRepository.delete({ id: In(staleTokenIds) });
    logger.info(
      { userId, evictedCount: staleTokenIds.length },
      "Evicted FCM tokens over the per-user limit"
    );
  }

  async scheduleExpirationWarning(
    ticket: Ticket
  ): Promise<TicketNotification | null> {
    if (!ticket.expiresAt) {
      return null;
    }

    const notifyAt = new Date(ticket.expiresAt.getTime() - EXPIRES_SOON_LEAD_MS);
    const notificationRepository =
      this.dataSource.getRepository(TicketNotification);

    return notificationRepository.save(
      notificationRepository.create({
        ticketId: ticket.id,
        userId: ticket.userId,
        notifyAt,
        status: TicketNotificationStatus.Pending
      })
    );
  }

  async processDueExpirationWarnings(
    now: Date = new Date()
  ): Promise<DueNotificationResult> {
    const notificationRepository =
      this.dataSource.getRepository(TicketNotification);
    const dueNotifications = await notificationRepository.find({
      where: {
        status: TicketNotificationStatus.Pending,
        notifyAt: LessThanOrEqual(now),
        attempts: LessThan(MAX_NOTIFICATION_ATTEMPTS)
      },
      order: { id: "ASC" },
      take: 50
    });

    const result: DueNotificationResult = {
      sentCount: 0,
      skippedCount: 0,
      failedCount: 0
    };

    for (const notification of dueNotifications) {
      const outcome = await this.processOne(notification, now);
      result[outcome] += 1;
    }

    return result;
  }

  private async processOne(
    notification: TicketNotification,
    now: Date
  ): Promise<"sentCount" | "skippedCount" | "failedCount"> {
    const notificationRepository =
      this.dataSource.getRepository(TicketNotification);
    const ticket = await this.dataSource.getRepository(Ticket).findOne({
      where: { id: notification.ticketId }
    });

    if (
      !ticket ||
      ticket.status !== TicketStatus.Pending ||
      !ticket.expiresAt ||
      ticket.expiresAt <= now
    ) {
      notification.status = TicketNotificationStatus.Skipped;
      notification.skippedAt = now;
      await notificationRepository.save(notification);
      return "skippedCount";
    }

    const tokens = await this.dataSource.getRepository(FcmToken).find({
      where: { userId: notification.userId }
    });

    if (tokens.length === 0) {
      notification.status = TicketNotificationStatus.Skipped;
      notification.skippedAt = now;
      await notificationRepository.save(notification);
      return "skippedCount";
    }

    notification.attempts += 1;

    if (!this.sender) {
      return this.recordFailure(
        notification,
        "Firebase Cloud Messaging is not configured"
      );
    }

    try {
      const sendResult = await this.sender.sendToTokens(
        tokens.map((token) => token.token),
        {
          title: "Reservation expiring soon",
          body: "Your ticket reservation is almost out of time.",
          data: {
            ticketId: String(ticket.id),
            concertId: String(ticket.concertId)
          }
        }
      );

      await this.pruneInvalidTokens(sendResult.invalidTokens);

      // A resolved promise is not delivery: every token can fail inside a
      // successful multicast call.
      if (sendResult.successCount === 0) {
        return this.recordFailure(
          notification,
          `All ${sendResult.failureCount} FCM token(s) rejected the message`
        );
      }

      notification.status = TicketNotificationStatus.Sent;
      notification.sentAt = now;
      notification.error = null;
      await notificationRepository.save(notification);
      return "sentCount";
    } catch (error) {
      logger.error({ error }, "Failed to send FCM notification");
      return this.recordFailure(
        notification,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Leaves the row PENDING while retries remain so the worker picks it up
   * again; only a exhausted budget makes the failure terminal.
   */
  private async recordFailure(
    notification: TicketNotification,
    message: string
  ): Promise<"failedCount"> {
    const notificationRepository =
      this.dataSource.getRepository(TicketNotification);
    const retriesRemaining = notification.attempts < MAX_NOTIFICATION_ATTEMPTS;

    notification.status = retriesRemaining
      ? TicketNotificationStatus.Pending
      : TicketNotificationStatus.Failed;
    notification.error = message;
    await notificationRepository.save(notification);

    logger.warn(
      {
        notificationId: notification.id,
        attempts: notification.attempts,
        retriesRemaining,
        reason: message
      },
      "Ticket notification delivery failed"
    );

    return "failedCount";
  }

  private async pruneInvalidTokens(invalidTokens: string[]): Promise<void> {
    if (invalidTokens.length === 0) {
      return;
    }

    await this.dataSource
      .getRepository(FcmToken)
      .delete({ token: In(invalidTokens) });

    logger.info(
      { prunedCount: invalidTokens.length },
      "Pruned FCM tokens rejected as permanently invalid"
    );
  }
}
