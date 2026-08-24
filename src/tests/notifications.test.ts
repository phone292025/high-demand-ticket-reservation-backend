import { FcmToken } from "../entities/FcmToken";
import { Ticket } from "../entities/Ticket";
import {
  TicketNotification,
  TicketNotificationStatus
} from "../entities/TicketNotification";
import { TicketStatus } from "../entities/TicketStatus";
import { MAX_NOTIFICATION_ATTEMPTS } from "../services/notification.service";
import type { TestHarness } from "./helpers/test-harness";
import { createTestHarness } from "./helpers/test-harness";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const DUE = new Date("2020-01-01T00:00:00.000Z");
const FUTURE = new Date("2030-01-01T00:00:00.000Z");

describe("Expiry notifications", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness();
  });

  afterEach(async () => {
    await harness.destroy();
  });

  async function createPendingTicket(userId = "firebase_owner"): Promise<Ticket> {
    const concert = await harness.createConcert(1);
    const ticketRepository = harness.dataSource.getRepository(Ticket);
    return ticketRepository.save(
      ticketRepository.create({
        concertId: concert.id,
        userId,
        status: TicketStatus.Pending,
        expiresAt: FUTURE,
        category: "General",
        quantity: 1
      })
    );
  }

  async function queueNotification(ticket: Ticket): Promise<TicketNotification> {
    const notificationRepository =
      harness.dataSource.getRepository(TicketNotification);
    return notificationRepository.save(
      notificationRepository.create({
        ticketId: ticket.id,
        userId: ticket.userId,
        notifyAt: DUE,
        status: TicketNotificationStatus.Pending
      })
    );
  }

  async function registerToken(
    token: string,
    userId = "firebase_owner"
  ): Promise<FcmToken> {
    const tokenRepository = harness.dataSource.getRepository(FcmToken);
    return tokenRepository.save(tokenRepository.create({ userId, token }));
  }

  function reload(notification: TicketNotification) {
    return harness.dataSource
      .getRepository(TicketNotification)
      .findOneByOrFail({ id: notification.id });
  }

  it("schedules an expiration warning after an authenticated reservation", async () => {
    const concert = await harness.createConcert(1);
    const reserveResponse = await harness
      .authenticatedRequest()
      .send({ concertId: concert.id, category: "General", quantity: 1 })
      .expect(201);

    const notification = await harness.dataSource
      .getRepository(TicketNotification)
      .findOneByOrFail({ ticketId: reserveResponse.body.ticket.id });

    expect(notification.status).toBe(TicketNotificationStatus.Pending);
    expect(notification.attempts).toBe(0);
  });

  it("skips expiry notification when the ticket is already completed", async () => {
    const concert = await harness.createConcert(1);
    const ticketRepository = harness.dataSource.getRepository(Ticket);
    const ticket = await ticketRepository.save(
      ticketRepository.create({
        concertId: concert.id,
        userId: "firebase_owner",
        status: TicketStatus.Completed,
        expiresAt: FUTURE,
        category: "General",
        quantity: 1
      })
    );
    const notification = await queueNotification(ticket);

    await harness.notificationService.processDueExpirationWarnings(NOW);

    expect((await reload(notification)).status).toBe(
      TicketNotificationStatus.Skipped
    );
  });

  it("sends expiry notification to registered FCM tokens for pending tickets", async () => {
    const ticket = await createPendingTicket();
    await registerToken("registered-token-with-enough-length");
    const notification = await queueNotification(ticket);

    await harness.notificationService.processDueExpirationWarnings(NOW);

    expect(harness.notificationSender.sendToTokens).toHaveBeenCalledWith(
      ["registered-token-with-enough-length"],
      expect.objectContaining({ title: "Reservation expiring soon" })
    );
    expect((await reload(notification)).status).toBe(TicketNotificationStatus.Sent);
  });

  it("does not record a send when every token was rejected", async () => {
    const ticket = await createPendingTicket();
    await registerToken("doomed-token-with-enough-length");
    const notification = await queueNotification(ticket);

    harness.notificationSender.sendToTokens.mockResolvedValue({
      successCount: 0,
      failureCount: 1,
      invalidTokens: []
    });

    const result =
      await harness.notificationService.processDueExpirationWarnings(NOW);
    const reloaded = await reload(notification);

    expect(result.sentCount).toBe(0);
    expect(result.failedCount).toBe(1);
    // Retries remain, so it stays PENDING for the worker to pick up again.
    expect(reloaded.status).toBe(TicketNotificationStatus.Pending);
    expect(reloaded.attempts).toBe(1);
    expect(reloaded.error).toContain("rejected");
  });

  it("prunes tokens FCM reports as permanently invalid", async () => {
    const ticket = await createPendingTicket();
    await registerToken("dead-token-with-enough-length");
    await registerToken("live-token-with-enough-length");
    await queueNotification(ticket);

    harness.notificationSender.sendToTokens.mockResolvedValue({
      successCount: 1,
      failureCount: 1,
      invalidTokens: ["dead-token-with-enough-length"]
    });

    await harness.notificationService.processDueExpirationWarnings(NOW);

    const remaining = await harness.dataSource.getRepository(FcmToken).find();
    expect(remaining.map((token) => token.token)).toEqual([
      "live-token-with-enough-length"
    ]);
  });

  it("retries a failing notification and gives up after the attempt budget", async () => {
    const ticket = await createPendingTicket();
    await registerToken("flaky-token-with-enough-length");
    const notification = await queueNotification(ticket);

    harness.notificationSender.sendToTokens.mockRejectedValue(
      new Error("FCM unavailable")
    );

    for (let attempt = 1; attempt <= MAX_NOTIFICATION_ATTEMPTS; attempt += 1) {
      await harness.notificationService.processDueExpirationWarnings(NOW);
      const reloaded = await reload(notification);

      expect(reloaded.attempts).toBe(attempt);
      expect(reloaded.status).toBe(
        attempt < MAX_NOTIFICATION_ATTEMPTS
          ? TicketNotificationStatus.Pending
          : TicketNotificationStatus.Failed
      );
    }

    // Exhausted rows are no longer selected by the worker.
    const afterGivingUp =
      await harness.notificationService.processDueExpirationWarnings(NOW);
    expect(afterGivingUp).toEqual({
      sentCount: 0,
      skippedCount: 0,
      failedCount: 0
    });
    expect(harness.notificationSender.sendToTokens).toHaveBeenCalledTimes(
      MAX_NOTIFICATION_ATTEMPTS
    );
  });

  it("recovers when a retried send finally succeeds", async () => {
    const ticket = await createPendingTicket();
    await registerToken("recovering-token-with-enough-length");
    const notification = await queueNotification(ticket);

    harness.notificationSender.sendToTokens.mockRejectedValueOnce(
      new Error("transient")
    );

    await harness.notificationService.processDueExpirationWarnings(NOW);
    expect((await reload(notification)).status).toBe(
      TicketNotificationStatus.Pending
    );

    await harness.notificationService.processDueExpirationWarnings(NOW);
    const recovered = await reload(notification);

    expect(recovered.status).toBe(TicketNotificationStatus.Sent);
    expect(recovered.error).toBeNull();
  });
});
