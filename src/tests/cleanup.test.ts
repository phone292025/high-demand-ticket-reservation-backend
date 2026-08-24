import request from "supertest";
import { In } from "typeorm";
import { Concert } from "../entities/Concert";
import { Ticket } from "../entities/Ticket";
import { TicketStatus } from "../entities/TicketStatus";
import { startCleanupWorker } from "../operations/cleanup-worker";
import { CleanupService } from "../services/cleanup.service";
import type { TestHarness } from "./helpers/test-harness";
import { createTestHarness } from "./helpers/test-harness";

const EXPIRED = new Date("2020-01-01T00:00:00.000Z");
const FUTURE = new Date("2030-01-01T00:00:00.000Z");

describe("Expired reservation cleanup", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness();
  });

  afterEach(async () => {
    await harness.destroy();
  });

  it("cleans up only expired pending reservations and restores quantity", async () => {
    const concert = await harness.createConcert(3);
    concert.availableStock = 0;
    await harness.dataSource.getRepository(Concert).save(concert);
    const ticketRepository = harness.dataSource.getRepository(Ticket);

    const expiredPendingTicket = await ticketRepository.save(
      ticketRepository.create({
        concertId: concert.id,
        userId: "expired_user",
        status: TicketStatus.Pending,
        expiresAt: EXPIRED,
        category: "General",
        quantity: 2
      })
    );
    const freshPendingTicket = await ticketRepository.save(
      ticketRepository.create({
        concertId: concert.id,
        userId: "fresh_user",
        status: TicketStatus.Pending,
        expiresAt: FUTURE,
        category: "General",
        quantity: 1
      })
    );
    const completedTicket = await ticketRepository.save(
      ticketRepository.create({
        concertId: concert.id,
        userId: "completed_user",
        status: TicketStatus.Completed,
        expiresAt: EXPIRED,
        category: "General",
        quantity: 1
      })
    );

    const response = await request(harness.app).post("/cleanup").expect(200);
    const updatedConcert = await harness.dataSource
      .getRepository(Concert)
      .findOneByOrFail({ id: concert.id });
    const reloadedTickets = await ticketRepository.findBy({
      id: In([expiredPendingTicket.id, freshPendingTicket.id, completedTicket.id])
    });

    expect(response.body.expiredCount).toBe(1);
    expect(response.body.releasedByConcert[String(concert.id)]).toBe(2);
    expect(updatedConcert.availableStock).toBe(2);
    expect(
      reloadedTickets.find((ticket) => ticket.id === expiredPendingTicket.id)
        ?.status
    ).toBe(TicketStatus.Expired);
    expect(
      reloadedTickets.find((ticket) => ticket.id === freshPendingTicket.id)?.status
    ).toBe(TicketStatus.Pending);
    expect(
      reloadedTickets.find((ticket) => ticket.id === completedTicket.id)?.status
    ).toBe(TicketStatus.Completed);
  });

  it("does not restore cleanup stock above total stock", async () => {
    const concert = await harness.createConcert(1);
    const ticketRepository = harness.dataSource.getRepository(Ticket);

    await ticketRepository.save([
      ticketRepository.create({
        concertId: concert.id,
        userId: "expired_user_1",
        status: TicketStatus.Pending,
        expiresAt: EXPIRED,
        category: "General",
        quantity: 1
      }),
      ticketRepository.create({
        concertId: concert.id,
        userId: "expired_user_2",
        status: TicketStatus.Pending,
        expiresAt: EXPIRED,
        category: "General",
        quantity: 1
      })
    ]);

    await request(harness.app).post("/cleanup").expect(200);

    const updatedConcert = await harness.dataSource
      .getRepository(Concert)
      .findOneByOrFail({ id: concert.id });

    expect(updatedConcert.availableStock).toBe(1);
  });

  it("releases stock on a schedule without anyone calling /cleanup", async () => {
    const concert = await harness.createConcert(2);
    const ticketRepository = harness.dataSource.getRepository(Ticket);

    await harness.reserve(concert.id, "abandoning_user", 2).expect(201);
    await ticketRepository.update(
      { concertId: concert.id },
      { expiresAt: EXPIRED }
    );

    expect(
      (
        await harness.dataSource
          .getRepository(Concert)
          .findOneByOrFail({ id: concert.id })
      ).availableStock
    ).toBe(0);

    const worker = startCleanupWorker(new CleanupService(harness.dataSource), 10);

    try {
      await new Promise((resolve) => setTimeout(resolve, 120));
    } finally {
      worker.stop();
    }

    const recovered = await harness.dataSource
      .getRepository(Concert)
      .findOneByOrFail({ id: concert.id });
    const expiredTicketCount = await ticketRepository.count({
      where: { concertId: concert.id, status: TicketStatus.Expired }
    });

    expect(recovered.availableStock).toBe(2);
    expect(expiredTicketCount).toBe(1);
  });
});
