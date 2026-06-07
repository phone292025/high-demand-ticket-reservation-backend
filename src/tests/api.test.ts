import request from "supertest";
import { DataSource, In } from "typeorm";
import { createApp } from "../app";
import { FirebaseAuthVerifier, FirebaseUser } from "../auth/firebase-admin";
import { createDataSource, initializeDataSource } from "../data-source";
import { Concert } from "../entities/Concert";
import { FcmToken } from "../entities/FcmToken";
import { Ticket } from "../entities/Ticket";
import {
  TicketNotification,
  TicketNotificationStatus
} from "../entities/TicketNotification";
import { TicketStatus } from "../entities/TicketStatus";
import { seedConcerts } from "../scripts/seed";
import {
  NotificationSender,
  NotificationService
} from "../services/notification.service";
import { ReservationService } from "../services/reservation.service";

describe("High-demand ticket reservation API", () => {
  let dataSource: DataSource;
  let app: ReturnType<typeof createApp>;
  let notificationSender: jest.Mocked<NotificationSender>;
  let notificationService: NotificationService;
  let firebaseAuthVerifier: jest.Mocked<FirebaseAuthVerifier>;

  const firebaseUsers: Record<string, FirebaseUser> = {
    owner_token: { uid: "firebase_owner", email: "owner@example.test" },
    other_token: { uid: "firebase_other", email: "other@example.test" }
  };

  beforeEach(async () => {
    dataSource = createDataSource(":memory:");
    await initializeDataSource(dataSource);
    await dataSource.runMigrations();
    await seedConcerts(dataSource);
    notificationSender = {
      sendToTokens: jest.fn().mockResolvedValue(undefined)
    };
    notificationService = new NotificationService(dataSource, notificationSender);
    firebaseAuthVerifier = {
      verifyIdToken: jest.fn(async (idToken: string) => {
        const user = firebaseUsers[idToken];

        if (!user) {
          throw new Error("Invalid token");
        }

        return user;
      })
    };
    app = createApp(dataSource, {
      enableLegacyDemoRoutes: true,
      enablePublicCleanup: true,
      firebaseAuthVerifier,
      notificationService
    });
  });

  afterEach(async () => {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  });

  async function createConcert(stock: number): Promise<Concert> {
    return dataSource.getRepository(Concert).save(
      dataSource.getRepository(Concert).create({
        name: `Test Concert ${Date.now()} ${Math.random()}`,
        venue: "Test Venue",
        startsAt: new Date("2026-12-01T20:00:00.000Z"),
        totalStock: stock,
        availableStock: stock
      })
    );
  }

  function reserve(concertId: number, userId: string, quantity = 1) {
    return request(app)
      .post("/reserve")
      .send({ concertId, userId, category: "General", quantity });
  }

  function authenticatedRequest(token = "owner_token") {
    return request(app).post("/api/v1/reserve").set("Authorization", `Bearer ${token}`);
  }

  it("returns health status with a generated correlation id", async () => {
    const response = await request(app).get("/health").expect(200);

    expect(response.body).toEqual({ status: "ok" });
    expect(response.headers["x-correlation-id"]).toBeDefined();
  });

  it("preserves a provided correlation id", async () => {
    const response = await request(app)
      .get("/health")
      .set("X-Correlation-ID", "test-correlation")
      .expect(200);

    expect(response.headers["x-correlation-id"]).toBe("test-correlation");
  });

  it("returns API information from the root route", async () => {
    const response = await request(app).get("/").expect(200);

    expect(response.body.endpoints).toMatchObject({
      health: "GET /health",
      concerts: "GET /concerts",
      tickets: "GET /tickets",
      reserve: "POST /reserve",
      createTicket: "POST /tickets",
      purchase: "POST /purchase",
      purchaseOptimistic: "POST /tickets/:ticketId/purchase-optimistic",
      purchasePessimistic: "POST /tickets/:ticketId/purchase-pessimistic",
      cleanup: "POST /cleanup"
    });
  });

  it("returns API information from the production /api/v1 route", async () => {
    const response = await request(app).get("/api/v1").expect(200);

    expect(response.body.endpoints).toMatchObject({
      healthV1: "GET /api/v1/health",
      concertsV1: "GET /api/v1/concerts",
      ticketsV1: "GET /api/v1/tickets",
      reserveV1: "POST /api/v1/reserve",
      purchaseV1: "POST /api/v1/purchase",
      cleanupV1: "POST /api/v1/cleanup",
      myTickets: "GET /api/v1/me/tickets",
      fcmTokens: "POST /api/v1/me/fcm-tokens"
    });
  });

  it("does not expose legacy demo or public cleanup routes unless enabled", async () => {
    const secureDefaultApp = createApp(dataSource, {
      firebaseAuthVerifier,
      notificationService
    });

    const indexResponse = await request(secureDefaultApp).get("/").expect(200);
    expect(indexResponse.body.endpoints).not.toHaveProperty("tickets");
    expect(indexResponse.body.endpoints).not.toHaveProperty("reserve");
    expect(indexResponse.body.endpoints).not.toHaveProperty("purchase");
    expect(indexResponse.body.endpoints).not.toHaveProperty("cleanup");

    await request(secureDefaultApp).get("/api/v1/tickets").expect(404);
    await request(secureDefaultApp)
      .post("/reserve")
      .send({ concertId: 1, userId: "attacker", category: "General", quantity: 1 })
      .expect(404);
    await request(secureDefaultApp)
      .post("/purchase")
      .send({ ticketId: 1, userId: "attacker" })
      .expect(404);
    await request(secureDefaultApp).post("/api/v1/cleanup").expect(404);
  });

  it("serves health and Swagger through production aliases", async () => {
    await request(app).get("/api/v1/health").expect(200);
    await request(app).get("/docs/").expect(200);
    await request(app).get("/api/v1/docs/").expect(200);
  });

  it("serves the Offline PWA shell and manifest", async () => {
    await request(app).get("/app/index.html").expect(200);
    await request(app).get("/app/manifest.webmanifest").expect(200);
    await request(app).get("/app/sw.js").expect(200);
  });

  it("maps malformed JSON through the global error middleware", async () => {
    const response = await request(app)
      .post("/reserve")
      .set("Content-Type", "application/json")
      .set("X-Correlation-ID", "bad-json-correlation")
      .send("{bad json")
      .expect(400);

    expect(response.body).toEqual({
      error: "VALIDATION_ERROR",
      message: "Invalid JSON body",
      ref: "bad-json-correlation"
    });
  });

  it("rejects unknown request fields with Zod strict validation", async () => {
    const response = await request(app)
      .post("/reserve")
      .set("X-Correlation-ID", "strict-validation")
      .send({
        concertId: 1,
        userId: "user_123",
        category: "General",
        quantity: 1,
        unexpected: "nope"
      })
      .expect(400);

    expect(response.body).toEqual({
      error: "VALIDATION_ERROR",
      message: "Invalid request body",
      ref: "strict-validation"
    });
  });

  it("protects the ConcurrencyError debug endpoint", async () => {
    const previousDebugSecret = process.env.DEBUG_SECRET;

    try {
      delete process.env.DEBUG_SECRET;
      await request(app)
        .post("/api/v1/debug/concurrency-error")
        .set("X-Debug-Secret", "secret")
        .expect(404);

      process.env.DEBUG_SECRET = "debug-secret";
      await request(app)
        .post("/api/v1/debug/concurrency-error")
        .set("X-Debug-Secret", "wrong-secret")
        .expect(403);

      const response = await request(app)
        .post("/api/v1/debug/concurrency-error")
        .set("X-Debug-Secret", "debug-secret")
        .expect(409);

      expect(response.body.error).toBe("LOCK_CONFLICT");
      expect(response.body.message).toBe(
        "Manual ConcurrencyError test triggered for Sentry verification"
      );
    } finally {
      if (previousDebugSecret === undefined) {
        delete process.env.DEBUG_SECRET;
      } else {
        process.env.DEBUG_SECRET = previousDebugSecret;
      }
    }
  });

  it("rejects quantity outside 1 to 5", async () => {
    const response = await request(app)
      .post("/reserve")
      .send({
        concertId: 1,
        userId: "user_123",
        category: "General",
        quantity: 6
      })
      .expect(400);

    expect(response.body.error).toBe("VALIDATION_ERROR");
  });

  it("returns seeded concerts", async () => {
    const response = await request(app).get("/concerts").expect(200);
    const concertNames = response.body.map((concert: Concert) => concert.name);

    expect(concertNames).toEqual(
      expect.arrayContaining([
        "Rock Night 2026",
        "APU Live Concert",
        "VIP Acoustic Show"
      ])
    );
  });

  it("reserves tickets and decreases stock by quantity", async () => {
    const concert = await dataSource.getRepository(Concert).findOneByOrFail({
      name: "Rock Night 2026"
    });

    const response = await reserve(concert.id, "user_123", 3).expect(201);
    const updatedConcert = await dataSource
      .getRepository(Concert)
      .findOneByOrFail({ id: concert.id });

    expect(response.body.ticket).toMatchObject({
      concertId: concert.id,
      userId: "user_123",
      status: TicketStatus.Pending,
      category: "General",
      quantity: 3
    });
    expect(response.body.ticket.version).toBeUndefined();
    expect(response.body.ticket.internalNote).toBeUndefined();
    expect(updatedConcert.availableStock).toBe(concert.availableStock - 3);
  });

  it("uses the same reservation behavior through POST /tickets", async () => {
    const concert = await createConcert(2);

    const response = await request(app)
      .post("/tickets")
      .send({
        concertId: concert.id,
        userId: "ticket_alias_user",
        category: "General",
        quantity: 2
      })
      .expect(201);

    const updatedConcert = await dataSource
      .getRepository(Concert)
      .findOneByOrFail({ id: concert.id });

    expect(response.body.ticket.quantity).toBe(2);
    expect(updatedConcert.availableStock).toBe(0);
  });

  it("uses the same reservation behavior through POST /api/v1/reserve", async () => {
    const concert = await createConcert(2);

    const response = await authenticatedRequest()
      .send({
        concertId: concert.id,
        category: "General",
        quantity: 2
      })
      .expect(201);

    const updatedConcert = await dataSource
      .getRepository(Concert)
      .findOneByOrFail({ id: concert.id });

    expect(response.body.ticket).toMatchObject({
      quantity: 2,
      userId: "firebase_owner"
    });
    expect(updatedConcert.availableStock).toBe(0);
  });

  it("rejects authenticated reservation when the Firebase token is missing", async () => {
    const concert = await createConcert(1);

    const response = await request(app)
      .post("/api/v1/reserve")
      .send({ concertId: concert.id, category: "General", quantity: 1 })
      .expect(401);

    expect(response.body.error).toBe("UNAUTHORIZED");
  });

  it("rejects authenticated reservation when the authorization header is malformed", async () => {
    const concert = await createConcert(1);

    const response = await request(app)
      .post("/api/v1/reserve")
      .set("Authorization", "Token owner_token")
      .send({ concertId: concert.id, category: "General", quantity: 1 })
      .expect(401);

    expect(response.body.error).toBe("UNAUTHORIZED");
  });

  it("rejects authenticated reservation when Firebase rejects the token", async () => {
    const concert = await createConcert(1);

    const response = await authenticatedRequest("bad_token")
      .send({ concertId: concert.id, category: "General", quantity: 1 })
      .expect(401);

    expect(response.body.error).toBe("UNAUTHORIZED");
  });

  it("rejects reservation when concert is sold out", async () => {
    const concert = await createConcert(1);
    concert.availableStock = 0;
    await dataSource.getRepository(Concert).save(concert);

    const response = await reserve(concert.id, "user_123").expect(409);
    const ticketCount = await dataSource.getRepository(Ticket).count({
      where: { concertId: concert.id }
    });

    expect(response.body.error).toBe("SOLD_OUT");
    expect(ticketCount).toBe(0);
  });

  it("does not reserve more tickets than available under concurrent clicks", async () => {
    const concert = await createConcert(2);

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        reserve(concert.id, `concurrent_user_${index}`)
      )
    );

    const successCount = responses.filter((response) => response.status === 201).length;
    const soldOutCount = responses.filter((response) => response.status === 409).length;
    const updatedConcert = await dataSource
      .getRepository(Concert)
      .findOneByOrFail({ id: concert.id });
    const ticketCount = await dataSource.getRepository(Ticket).count({
      where: { concertId: concert.id, status: TicketStatus.Pending }
    });

    expect(successCount).toBe(2);
    expect(soldOutCount).toBe(8);
    expect(updatedConcert.availableStock).toBe(0);
    expect(ticketCount).toBe(2);
  });

  it("returns ticket DTOs without version or internalNote", async () => {
    const concert = await createConcert(1);
    const ticket = await dataSource.getRepository(Ticket).save(
      dataSource.getRepository(Ticket).create({
        concertId: concert.id,
        userId: "dto_user",
        status: TicketStatus.Pending,
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        category: "General",
        quantity: 1,
        internalNote: "do not leak"
      })
    );

    const response = await request(app).get("/tickets").expect(200);
    const dto = response.body.find((item: { id: number }) => item.id === ticket.id);

    expect(dto).toMatchObject({
      id: ticket.id,
      concertId: concert.id,
      userId: "dto_user",
      quantity: 1
    });
    expect(dto.version).toBeUndefined();
    expect(dto.internalNote).toBeUndefined();
  });

  it("only lets one optimistic purchase complete", async () => {
    const concert = await createConcert(1);
    const reserveResponse = await reserve(concert.id, "owner_user").expect(201);
    const ticketId = reserveResponse.body.ticket.id;

    const responses = await Promise.all([
      request(app)
        .post(`/tickets/${ticketId}/purchase-optimistic`)
        .send({ userId: "owner_user" }),
      request(app)
        .post(`/tickets/${ticketId}/purchase-optimistic`)
        .send({ userId: "owner_user" })
    ]);

    const successCount = responses.filter((response) => response.status === 200).length;
    const conflictCount = responses.filter((response) => response.status === 409).length;

    expect(successCount).toBe(1);
    expect(conflictCount).toBe(1);
    expect(
      responses.find((response) => response.status === 409)?.body.error
    ).toBe("LOCK_CONFLICT");
  });

  it("only lets one pessimistic purchase complete", async () => {
    const concert = await createConcert(1);
    const reserveResponse = await reserve(concert.id, "owner_user").expect(201);
    const ticketId = reserveResponse.body.ticket.id;

    const first = await request(app)
      .post(`/tickets/${ticketId}/purchase-pessimistic`)
      .send({ userId: "owner_user" })
      .expect(200);
    const second = await request(app)
      .post(`/tickets/${ticketId}/purchase-pessimistic`)
      .send({ userId: "owner_user" })
      .expect(409);

    expect(first.body.ticket.status).toBe(TicketStatus.Completed);
    expect(second.body.error).toBe("LOCK_CONFLICT");
  });

  it("keeps /purchase as a backwards-compatible route", async () => {
    const concert = await createConcert(1);
    const reserveResponse = await reserve(concert.id, "owner_user").expect(201);

    await request(app)
      .post("/purchase")
      .send({ ticketId: reserveResponse.body.ticket.id, userId: "other_user" })
      .expect(409);

    const purchaseResponse = await request(app)
      .post("/purchase")
      .send({ ticketId: reserveResponse.body.ticket.id, userId: "owner_user" })
      .expect(200);

    expect(purchaseResponse.body.ticket.status).toBe(TicketStatus.Completed);
  });

  it("purchases through /api/v1/purchase with the Firebase uid", async () => {
    const concert = await createConcert(1);
    const reserveResponse = await authenticatedRequest()
      .send({ concertId: concert.id, category: "General", quantity: 1 })
      .expect(201);

    await request(app)
      .post("/api/v1/purchase")
      .set("Authorization", "Bearer other_token")
      .send({ ticketId: reserveResponse.body.ticket.id })
      .expect(409);

    const purchaseResponse = await request(app)
      .post("/api/v1/purchase")
      .set("Authorization", "Bearer owner_token")
      .send({ ticketId: reserveResponse.body.ticket.id })
      .expect(200);

    expect(purchaseResponse.body.ticket.status).toBe(TicketStatus.Completed);
  });

  it("purchases through the authenticated route purchase endpoint without userId", async () => {
    const concert = await createConcert(1);
    const reserveResponse = await authenticatedRequest()
      .send({ concertId: concert.id, category: "General", quantity: 1 })
      .expect(201);

    const response = await request(app)
      .post(`/api/v1/tickets/${reserveResponse.body.ticket.id}/purchase-optimistic`)
      .set("Authorization", "Bearer owner_token")
      .send({})
      .expect(200);

    expect(response.body.ticket.userId).toBe("firebase_owner");
  });

  it("returns only the signed-in user's tickets", async () => {
    const concert = await createConcert(2);
    await authenticatedRequest()
      .send({ concertId: concert.id, category: "General", quantity: 1 })
      .expect(201);
    await authenticatedRequest("other_token")
      .send({ concertId: concert.id, category: "General", quantity: 1 })
      .expect(201);

    const response = await request(app)
      .get("/api/v1/me/tickets")
      .set("Authorization", "Bearer owner_token")
      .expect(200);

    expect(response.body).toEqual([
      expect.objectContaining({ userId: "firebase_owner" })
    ]);
  });

  it("upserts FCM tokens for the signed-in user", async () => {
    const token = "fcm-token-value-with-enough-length";

    await request(app)
      .post("/api/v1/me/fcm-tokens")
      .set("Authorization", "Bearer owner_token")
      .send({ token })
      .expect(201);
    await request(app)
      .post("/api/v1/me/fcm-tokens")
      .set("Authorization", "Bearer other_token")
      .send({ token })
      .expect(201);

    const tokens = await dataSource.getRepository(FcmToken).find();

    expect(tokens).toEqual([
      expect.objectContaining({ token, userId: "firebase_other" })
    ]);
  });

  it("deletes only the signed-in user's FCM token", async () => {
    const token = "fcm-token-value-with-enough-length";

    await request(app)
      .post("/api/v1/me/fcm-tokens")
      .set("Authorization", "Bearer owner_token")
      .send({ token })
      .expect(201);

    await request(app)
      .delete("/api/v1/me/fcm-tokens")
      .set("Authorization", "Bearer other_token")
      .send({ token })
      .expect(204);

    expect(await dataSource.getRepository(FcmToken).count()).toBe(1);

    await request(app)
      .delete("/api/v1/me/fcm-tokens")
      .set("Authorization", "Bearer owner_token")
      .send({ token })
      .expect(204);

    expect(await dataSource.getRepository(FcmToken).count()).toBe(0);
  });

  it("schedules an expiration warning after an authenticated reservation", async () => {
    const concert = await createConcert(1);
    const reserveResponse = await authenticatedRequest()
      .send({ concertId: concert.id, category: "General", quantity: 1 })
      .expect(201);

    const notification = await dataSource
      .getRepository(TicketNotification)
      .findOneByOrFail({ ticketId: reserveResponse.body.ticket.id });

    expect(notification.status).toBe(TicketNotificationStatus.Pending);
  });

  it("skips expiry notification when the ticket is already completed", async () => {
    const concert = await createConcert(1);
    const ticket = await dataSource.getRepository(Ticket).save(
      dataSource.getRepository(Ticket).create({
        concertId: concert.id,
        userId: "firebase_owner",
        status: TicketStatus.Completed,
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        category: "General",
        quantity: 1
      })
    );
    const notification = await dataSource.getRepository(TicketNotification).save(
      dataSource.getRepository(TicketNotification).create({
        ticketId: ticket.id,
        userId: "firebase_owner",
        notifyAt: new Date("2020-01-01T00:00:00.000Z"),
        status: TicketNotificationStatus.Pending
      })
    );

    await notificationService.processDueExpirationWarnings(
      new Date("2026-01-01T00:00:00.000Z")
    );
    const reloadedNotification = await dataSource
      .getRepository(TicketNotification)
      .findOneByOrFail({ id: notification.id });

    expect(reloadedNotification.status).toBe(TicketNotificationStatus.Skipped);
  });

  it("sends expiry notification to registered FCM tokens for pending tickets", async () => {
    const concert = await createConcert(1);
    const ticket = await dataSource.getRepository(Ticket).save(
      dataSource.getRepository(Ticket).create({
        concertId: concert.id,
        userId: "firebase_owner",
        status: TicketStatus.Pending,
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        category: "General",
        quantity: 1
      })
    );
    await dataSource.getRepository(FcmToken).save(
      dataSource.getRepository(FcmToken).create({
        userId: "firebase_owner",
        token: "registered-token-with-enough-length"
      })
    );
    await dataSource.getRepository(TicketNotification).save(
      dataSource.getRepository(TicketNotification).create({
        ticketId: ticket.id,
        userId: "firebase_owner",
        notifyAt: new Date("2020-01-01T00:00:00.000Z"),
        status: TicketNotificationStatus.Pending
      })
    );

    await notificationService.processDueExpirationWarnings(
      new Date("2026-01-01T00:00:00.000Z")
    );

    expect(notificationSender.sendToTokens).toHaveBeenCalledWith(
      ["registered-token-with-enough-length"],
      expect.objectContaining({
        title: "Reservation expiring soon"
      })
    );
  });

  it("rejects purchase for an expired pending ticket", async () => {
    const concert = await createConcert(1);
    const expiredTicket = await dataSource.getRepository(Ticket).save(
      dataSource.getRepository(Ticket).create({
        concertId: concert.id,
        userId: "late_user",
        status: TicketStatus.Pending,
        expiresAt: new Date("2020-01-01T00:00:00.000Z"),
        category: "General",
        quantity: 1
      })
    );

    const response = await request(app)
      .post("/purchase")
      .send({ ticketId: expiredTicket.id, userId: "late_user" })
      .expect(409);

    expect(response.body.error).toBe("LOCK_CONFLICT");
  });

  it("cleans up only expired pending reservations and restores quantity", async () => {
    const concert = await createConcert(3);
    concert.availableStock = 0;
    await dataSource.getRepository(Concert).save(concert);
    const ticketRepository = dataSource.getRepository(Ticket);
    const oldDate = new Date("2020-01-01T00:00:00.000Z");
    const futureDate = new Date("2030-01-01T00:00:00.000Z");

    const expiredPendingTicket = await ticketRepository.save(
      ticketRepository.create({
        concertId: concert.id,
        userId: "expired_user",
        status: TicketStatus.Pending,
        expiresAt: oldDate,
        category: "General",
        quantity: 2
      })
    );
    const freshPendingTicket = await ticketRepository.save(
      ticketRepository.create({
        concertId: concert.id,
        userId: "fresh_user",
        status: TicketStatus.Pending,
        expiresAt: futureDate,
        category: "General",
        quantity: 1
      })
    );
    const completedTicket = await ticketRepository.save(
      ticketRepository.create({
        concertId: concert.id,
        userId: "completed_user",
        status: TicketStatus.Completed,
        expiresAt: oldDate,
        category: "General",
        quantity: 1
      })
    );

    const response = await request(app).post("/cleanup").expect(200);
    const updatedConcert = await dataSource
      .getRepository(Concert)
      .findOneByOrFail({ id: concert.id });
    const reloadedTickets = await ticketRepository.findBy({
      id: In([
        expiredPendingTicket.id,
        freshPendingTicket.id,
        completedTicket.id
      ])
    });

    expect(response.body.expiredCount).toBe(1);
    expect(response.body.releasedByConcert[String(concert.id)]).toBe(2);
    expect(updatedConcert.availableStock).toBe(2);
    expect(
      reloadedTickets.find((ticket) => ticket.id === expiredPendingTicket.id)?.status
    ).toBe(TicketStatus.Expired);
    expect(
      reloadedTickets.find((ticket) => ticket.id === freshPendingTicket.id)?.status
    ).toBe(TicketStatus.Pending);
    expect(
      reloadedTickets.find((ticket) => ticket.id === completedTicket.id)?.status
    ).toBe(TicketStatus.Completed);
  });

  it("rolls back stock when ticket save fails", async () => {
    const concert = await createConcert(1);
    const reservationService = new ReservationService(dataSource);

    await expect(
      reservationService.reserveTicket(
        { concertId: concert.id, userId: "rollback_user", quantity: 1 },
        { forceTicketSaveFailure: true }
      )
    ).rejects.toThrow();

    const updatedConcert = await dataSource
      .getRepository(Concert)
      .findOneByOrFail({ id: concert.id });
    const ticketCount = await dataSource.getRepository(Ticket).count({
      where: { concertId: concert.id, userId: "rollback_user" }
    });

    expect(updatedConcert.availableStock).toBe(1);
    expect(ticketCount).toBe(0);
  });

  it("does not restore cleanup stock above total stock", async () => {
    const concert = await createConcert(1);
    const ticketRepository = dataSource.getRepository(Ticket);

    await ticketRepository.save([
      ticketRepository.create({
        concertId: concert.id,
        userId: "expired_user_1",
        status: TicketStatus.Pending,
        expiresAt: new Date("2020-01-01T00:00:00.000Z"),
        category: "General",
        quantity: 1
      }),
      ticketRepository.create({
        concertId: concert.id,
        userId: "expired_user_2",
        status: TicketStatus.Pending,
        expiresAt: new Date("2020-01-01T00:00:00.000Z"),
        category: "General",
        quantity: 1
      })
    ]);

    await request(app).post("/cleanup").expect(200);

    const updatedConcert = await dataSource
      .getRepository(Concert)
      .findOneByOrFail({ id: concert.id });

    expect(updatedConcert.availableStock).toBe(1);
  });

  it("exposes the hardened endpoints in the Swagger spec", async () => {
    const response = await request(app).get("/api-docs.json").expect(200);

    expect(Object.keys(response.body.paths)).toEqual(
      expect.arrayContaining([
        "/reserve",
        "/tickets",
        "/tickets/{ticketId}/purchase-optimistic",
        "/tickets/{ticketId}/purchase-pessimistic"
      ])
    );
    expect(response.body.servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: "/api/v1" }),
        expect.objectContaining({ url: "/" })
      ])
    );
  });
});
