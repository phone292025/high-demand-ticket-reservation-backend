import { DataSource, LessThanOrEqual } from "typeorm";
import { Messaging } from "firebase-admin/messaging";
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

export interface NotificationSender {
  sendToTokens(tokens: string[], payload: NotificationSendPayload): Promise<void>;
}

export interface DueNotificationResult {
  sentCount: number;
  skippedCount: number;
  failedCount: number;
}

const EXPIRES_SOON_LEAD_MS = 60 * 1000;

export class FirebaseNotificationSender implements NotificationSender {
  constructor(private readonly messaging: Messaging) {}

  async sendToTokens(
    tokens: string[],
    payload: NotificationSendPayload
  ): Promise<void> {
    if (tokens.length === 0) {
      return;
    }

    await this.messaging.sendEachForMulticast({
      tokens,
      notification: {
        title: payload.title,
        body: payload.body
      },
      data: payload.data
    });
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

    return tokenRepository.save(
      tokenRepository.create({
        userId,
        token: trimmedToken
      })
    );
  }

  async unregisterFcmToken(userId: string, token: string): Promise<void> {
    const tokenRepository = this.dataSource.getRepository(FcmToken);
    await tokenRepository.delete({
      userId,
      token: token.trim()
    });
  }

  async scheduleExpirationWarning(ticket: Ticket): Promise<TicketNotification | null> {
    if (!ticket.expiresAt) {
      return null;
    }

    const notifyAt = new Date(ticket.expiresAt.getTime() - EXPIRES_SOON_LEAD_MS);
    const notificationRepository = this.dataSource.getRepository(TicketNotification);

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
    const notificationRepository = this.dataSource.getRepository(TicketNotification);
    const dueNotifications = await notificationRepository.find({
      where: {
        status: TicketNotificationStatus.Pending,
        notifyAt: LessThanOrEqual(now)
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
    const notificationRepository = this.dataSource.getRepository(TicketNotification);
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

    if (!this.sender) {
      notification.status = TicketNotificationStatus.Failed;
      notification.error = "Firebase Cloud Messaging is not configured";
      await notificationRepository.save(notification);
      return "failedCount";
    }

    try {
      await this.sender.sendToTokens(
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
      notification.status = TicketNotificationStatus.Sent;
      notification.sentAt = now;
      await notificationRepository.save(notification);
      return "sentCount";
    } catch (error) {
      logger.error({ error }, "Failed to send FCM notification");
      notification.status = TicketNotificationStatus.Failed;
      notification.error = error instanceof Error ? error.message : String(error);
      await notificationRepository.save(notification);
      return "failedCount";
    }
  }
}
