import request from "supertest";
import { Concert } from "../entities/Concert";
import { Ticket } from "../entities/Ticket";
import { TicketStatus } from "../entities/TicketStatus";
import { ReservationService } from "../services/reservation.service";
import type { TestHarness } from "./helpers/test-harness";
import { createTestHarness } from "./helpers/test-harness";

describe("Reservations", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness();
  });

  afterEach(async () => {
    await harness.destroy();
  });

  it("rejects quantity outside 1 to 5", async () => {
    const response = await request(harness.app)
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

  it("reserves tickets and decreases stock by quantity", async () => {
    const concert = await harness.dataSource
      .getRepository(Concert)
      .findOneByOrFail({ name: "Rock Night 2026" });

    const response = await harness.reserve(concert.id, "user_123", 3).expect(201);
    const updatedConcert = await harness.dataSource
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
    const concert = await harness.createConcert(2);

    const response = await request(harness.app)
      .post("/tickets")
      .send({
        concertId: concert.id,
        userId: "ticket_alias_user",
        category: "General",
        quantity: 2
      })
      .expect(201);

    const updatedConcert = await harness.dataSource
      .getRepository(Concert)
      .findOneByOrFail({ id: concert.id });

    expect(response.body.ticket.quantity).toBe(2);
    expect(updatedConcert.availableStock).toBe(0);
  });

  it("uses the same reservation behavior through POST /api/v1/reserve", async () => {
    const concert = await harness.createConcert(2);

    const response = await harness
      .authenticatedRequest()
      .send({
        concertId: concert.id,
        category: "General",
        quantity: 2
      })
      .expect(201);

    const updatedConcert = await harness.dataSource
      .getRepository(Concert)
      .findOneByOrFail({ id: concert.id });

    expect(response.body.ticket).toMatchObject({
      quantity: 2,
      userId: "firebase_owner"
    });
    expect(updatedConcert.availableStock).toBe(0);
  });

  it("rejects reservation when concert is sold out", async () => {
    const concert = await harness.createConcert(1);
    concert.availableStock = 0;
    await harness.dataSource.getRepository(Concert).save(concert);

    const response = await harness.reserve(concert.id, "user_123").expect(409);
    const ticketCount = await harness.dataSource.getRepository(Ticket).count({
      where: { concertId: concert.id }
    });

    expect(response.body.error).toBe("SOLD_OUT");
    expect(ticketCount).toBe(0);
  });

  it("returns 404 for a concert that does not exist", async () => {
    const response = await harness.reserve(999999, "user_123").expect(404);

    expect(response.body.error).toBe("NOT_FOUND");
  });

  it("does not reserve more tickets than available under concurrent clicks", async () => {
    const concert = await harness.createConcert(2);

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        harness.reserve(concert.id, `concurrent_user_${index}`)
      )
    );

    const successCount = responses.filter(
      (response) => response.status === 201
    ).length;
    const soldOutCount = responses.filter(
      (response) => response.status === 409
    ).length;
    const updatedConcert = await harness.dataSource
      .getRepository(Concert)
      .findOneByOrFail({ id: concert.id });
    const ticketCount = await harness.dataSource.getRepository(Ticket).count({
      where: { concertId: concert.id, status: TicketStatus.Pending }
    });

    expect(successCount).toBe(2);
    expect(soldOutCount).toBe(8);
    expect(updatedConcert.availableStock).toBe(0);
    expect(ticketCount).toBe(2);
  });

  it("returns ticket DTOs without version or internalNote", async () => {
    const concert = await harness.createConcert(1);
    const ticketRepository = harness.dataSource.getRepository(Ticket);
    const ticket = await ticketRepository.save(
      ticketRepository.create({
        concertId: concert.id,
        userId: "dto_user",
        status: TicketStatus.Pending,
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        category: "General",
        quantity: 1,
        internalNote: "do not leak"
      })
    );

    const response = await request(harness.app).get("/tickets").expect(200);
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

  it("rolls back stock when ticket save fails", async () => {
    const concert = await harness.createConcert(1);
    const reservationService = new ReservationService(harness.dataSource);

    await expect(
      reservationService.reserveTicket(
        { concertId: concert.id, userId: "rollback_user", quantity: 1 },
        { forceTicketSaveFailure: true }
      )
    ).rejects.toThrow();

    const updatedConcert = await harness.dataSource
      .getRepository(Concert)
      .findOneByOrFail({ id: concert.id });
    const ticketCount = await harness.dataSource.getRepository(Ticket).count({
      where: { concertId: concert.id, userId: "rollback_user" }
    });

    expect(updatedConcert.availableStock).toBe(1);
    expect(ticketCount).toBe(0);
  });

  it("refuses to drive availableStock below zero at the storage layer", async () => {
    const concert = await harness.createConcert(1);

    await expect(
      harness.dataSource.query(
        `UPDATE concerts SET "availableStock" = -1 WHERE id = ?`,
        [concert.id]
      )
    ).rejects.toThrow(/availableStock must be between 0 and totalStock/);
  });

  it("refuses to inflate availableStock past totalStock", async () => {
    const concert = await harness.createConcert(1);

    await expect(
      harness.dataSource.query(
        `UPDATE concerts SET "availableStock" = 99 WHERE id = ?`,
        [concert.id]
      )
    ).rejects.toThrow(/availableStock must be between 0 and totalStock/);
  });
});
