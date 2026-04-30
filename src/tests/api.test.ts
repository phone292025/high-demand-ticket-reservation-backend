import request from "supertest";
import { DataSource, In } from "typeorm";
import { createApp } from "../app";
import { createDataSource, initializeDataSource } from "../data-source";
import { Concert } from "../entities/Concert";
import { Ticket } from "../entities/Ticket";
import { TicketStatus } from "../entities/TicketStatus";
import { seedConcerts } from "../scripts/seed";
import { ReservationService } from "../services/reservation.service";

describe("High-demand ticket reservation API", () => {
  let dataSource: DataSource;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    dataSource = createDataSource(":memory:");
    await initializeDataSource(dataSource);
    await dataSource.runMigrations();
    await seedConcerts(dataSource);
    app = createApp(dataSource);
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
  });
});
