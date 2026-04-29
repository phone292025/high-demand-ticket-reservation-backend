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

  it("returns health status", async () => {
    const response = await request(app).get("/health").expect(200);

    expect(response.body).toEqual({ status: "ok" });
  });

  it("returns API information from the root route", async () => {
    const response = await request(app).get("/").expect(200);

    expect(response.body).toMatchObject({
      name: "High-Demand Ticket Reservation Backend",
      status: "ok",
      endpoints: {
        health: "GET /health",
        concerts: "GET /concerts",
        reserve: "POST /reserve",
        purchase: "POST /purchase",
        cleanup: "POST /cleanup"
      }
    });
  });

  it("returns a validation error for malformed JSON", async () => {
    const response = await request(app)
      .post("/reserve")
      .set("Content-Type", "application/json")
      .send("{bad json")
      .expect(400);

    expect(response.body).toEqual({ error: "Invalid JSON body" });
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

  it("reserves one ticket and decreases stock", async () => {
    const concert = await dataSource.getRepository(Concert).findOneByOrFail({
      name: "Rock Night 2026"
    });

    const response = await request(app)
      .post("/reserve")
      .send({ concertId: concert.id, userId: "user_123", category: "VIP" })
      .expect(201);

    const updatedConcert = await dataSource
      .getRepository(Concert)
      .findOneByOrFail({ id: concert.id });

    expect(response.body.ticket).toMatchObject({
      concertId: concert.id,
      userId: "user_123",
      status: TicketStatus.Pending,
      category: "VIP"
    });
    expect(updatedConcert.availableStock).toBe(concert.availableStock - 1);
  });

  it("rejects reservation when concert is sold out", async () => {
    const concert = await createConcert(1);
    concert.availableStock = 0;
    await dataSource.getRepository(Concert).save(concert);

    const response = await request(app)
      .post("/reserve")
      .send({ concertId: concert.id, userId: "user_123" })
      .expect(409);

    const ticketCount = await dataSource.getRepository(Ticket).count({
      where: { concertId: concert.id }
    });

    expect(response.body).toEqual({ error: "Sold Out" });
    expect(ticketCount).toBe(0);
  });

  it("does not reserve more tickets than available under concurrent clicks", async () => {
    const concert = await createConcert(2);

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        request(app)
          .post("/reserve")
          .send({ concertId: concert.id, userId: `concurrent_user_${index}` })
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

  it("only lets the reservation owner purchase an unexpired pending ticket", async () => {
    const concert = await createConcert(1);
    const reserveResponse = await request(app)
      .post("/reserve")
      .send({ concertId: concert.id, userId: "owner_user" })
      .expect(201);

    await request(app)
      .post("/purchase")
      .send({ ticketId: reserveResponse.body.ticket.id, userId: "other_user" })
      .expect(409);

    const purchaseResponse = await request(app)
      .post("/purchase")
      .send({ ticketId: reserveResponse.body.ticket.id, userId: "owner_user" })
      .expect(200);

    await request(app)
      .post("/purchase")
      .send({ ticketId: reserveResponse.body.ticket.id, userId: "owner_user" })
      .expect(409);

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
        category: "General"
      })
    );

    const response = await request(app)
      .post("/purchase")
      .send({ ticketId: expiredTicket.id, userId: "late_user" })
      .expect(409);

    expect(response.body.error).toContain("expired");
  });

  it("cleans up only expired pending reservations and restores stock", async () => {
    const concert = await createConcert(1);
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
        category: "General"
      })
    );
    const freshPendingTicket = await ticketRepository.save(
      ticketRepository.create({
        concertId: concert.id,
        userId: "fresh_user",
        status: TicketStatus.Pending,
        expiresAt: futureDate,
        category: "General"
      })
    );
    const completedTicket = await ticketRepository.save(
      ticketRepository.create({
        concertId: concert.id,
        userId: "completed_user",
        status: TicketStatus.Completed,
        expiresAt: oldDate,
        category: "General"
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
    expect(updatedConcert.availableStock).toBe(1);
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
        { concertId: concert.id, userId: "rollback_user" },
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
        category: "General"
      }),
      ticketRepository.create({
        concertId: concert.id,
        userId: "expired_user_2",
        status: TicketStatus.Pending,
        expiresAt: new Date("2020-01-01T00:00:00.000Z"),
        category: "General"
      })
    ]);

    await request(app).post("/cleanup").expect(200);

    const updatedConcert = await dataSource
      .getRepository(Concert)
      .findOneByOrFail({ id: concert.id });

    expect(updatedConcert.availableStock).toBe(1);
  });
});
