import request from "supertest";
import { Ticket } from "../entities/Ticket";
import { TicketStatus } from "../entities/TicketStatus";
import type { TestHarness } from "./helpers/test-harness";
import { createTestHarness } from "./helpers/test-harness";

describe("Purchases", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness();
  });

  afterEach(async () => {
    await harness.destroy();
  });

  it("only lets one optimistic purchase complete", async () => {
    const concert = await harness.createConcert(1);
    const reserveResponse = await harness
      .reserve(concert.id, "owner_user")
      .expect(201);
    const ticketId = reserveResponse.body.ticket.id;

    const responses = await Promise.all([
      request(harness.app)
        .post(`/tickets/${ticketId}/purchase-optimistic`)
        .send({ userId: "owner_user" }),
      request(harness.app)
        .post(`/tickets/${ticketId}/purchase-optimistic`)
        .send({ userId: "owner_user" })
    ]);

    const successCount = responses.filter(
      (response) => response.status === 200
    ).length;
    const conflictCount = responses.filter(
      (response) => response.status === 409
    ).length;

    expect(successCount).toBe(1);
    expect(conflictCount).toBe(1);
    expect(responses.find((response) => response.status === 409)?.body.error).toBe(
      "LOCK_CONFLICT"
    );
  });

  it("only lets one pessimistic purchase complete", async () => {
    const concert = await harness.createConcert(1);
    const reserveResponse = await harness
      .reserve(concert.id, "owner_user")
      .expect(201);
    const ticketId = reserveResponse.body.ticket.id;

    const first = await request(harness.app)
      .post(`/tickets/${ticketId}/purchase-pessimistic`)
      .send({ userId: "owner_user" })
      .expect(200);
    const second = await request(harness.app)
      .post(`/tickets/${ticketId}/purchase-pessimistic`)
      .send({ userId: "owner_user" })
      .expect(409);

    expect(first.body.ticket.status).toBe(TicketStatus.Completed);
    expect(second.body.error).toBe("LOCK_CONFLICT");
  });

  it("keeps /purchase as a backwards-compatible route", async () => {
    const concert = await harness.createConcert(1);
    const reserveResponse = await harness
      .reserve(concert.id, "owner_user")
      .expect(201);

    await request(harness.app)
      .post("/purchase")
      .send({ ticketId: reserveResponse.body.ticket.id, userId: "other_user" })
      .expect(409);

    const purchaseResponse = await request(harness.app)
      .post("/purchase")
      .send({ ticketId: reserveResponse.body.ticket.id, userId: "owner_user" })
      .expect(200);

    expect(purchaseResponse.body.ticket.status).toBe(TicketStatus.Completed);
  });

  it("purchases through /api/v1/purchase with the Firebase uid", async () => {
    const concert = await harness.createConcert(1);
    const reserveResponse = await harness
      .authenticatedRequest()
      .send({ concertId: concert.id, category: "General", quantity: 1 })
      .expect(201);

    await request(harness.app)
      .post("/api/v1/purchase")
      .set("Authorization", "Bearer other_token")
      .send({ ticketId: reserveResponse.body.ticket.id })
      .expect(409);

    const purchaseResponse = await request(harness.app)
      .post("/api/v1/purchase")
      .set("Authorization", "Bearer owner_token")
      .send({ ticketId: reserveResponse.body.ticket.id })
      .expect(200);

    expect(purchaseResponse.body.ticket.status).toBe(TicketStatus.Completed);
  });

  it("purchases through the authenticated route purchase endpoint without userId", async () => {
    const concert = await harness.createConcert(1);
    const reserveResponse = await harness
      .authenticatedRequest()
      .send({ concertId: concert.id, category: "General", quantity: 1 })
      .expect(201);

    const response = await request(harness.app)
      .post(`/api/v1/tickets/${reserveResponse.body.ticket.id}/purchase-optimistic`)
      .set("Authorization", "Bearer owner_token")
      .send({})
      .expect(200);

    expect(response.body.ticket.userId).toBe("firebase_owner");
  });

  it("rejects purchase for an expired pending ticket", async () => {
    const concert = await harness.createConcert(1);
    const ticketRepository = harness.dataSource.getRepository(Ticket);
    const expiredTicket = await ticketRepository.save(
      ticketRepository.create({
        concertId: concert.id,
        userId: "late_user",
        status: TicketStatus.Pending,
        expiresAt: new Date("2020-01-01T00:00:00.000Z"),
        category: "General",
        quantity: 1
      })
    );

    const response = await request(harness.app)
      .post("/purchase")
      .send({ ticketId: expiredTicket.id, userId: "late_user" })
      .expect(409);

    expect(response.body.error).toBe("LOCK_CONFLICT");
  });
});
