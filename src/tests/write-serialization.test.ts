import { FcmToken } from "../entities/FcmToken";
import { Ticket } from "../entities/Ticket";
import { TicketNotification } from "../entities/TicketNotification";
import { ReservationService } from "../services/reservation.service";
import type { TestHarness } from "./helpers/test-harness";
import { createTestHarness } from "./helpers/test-harness";

/**
 * TypeORM hands every SQLite caller the same connection, so a write that runs
 * outside the write mutex joins whatever transaction is open at that moment.
 * These tests race writes against sold-out reservations, which roll back.
 */
describe("Write serialization on the shared SQLite connection", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness();
  });

  afterEach(async () => {
    await harness.destroy();
  });

  function afterTicks(ticks: number): Promise<void> {
    return new Promise((resolve) => {
      const step = (remaining: number) =>
        remaining <= 0 ? resolve() : setImmediate(() => step(remaining - 1));
      step(ticks);
    });
  }

  it("keeps a token registration that overlaps a sold-out rollback", async () => {
    const soldOut = await harness.createConcert(0);
    const reservations = new ReservationService(harness.dataSource);
    const registered: string[] = [];

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const failingReservation = reservations
        .reserveTickets({ concertId: soldOut.id, userId: "buyer", quantity: 1 })
        .catch(() => undefined);
      await afterTicks(attempt % 5);

      const token = `token-${attempt}`;
      const registration = harness.notificationService
        .registerFcmToken(`user-${attempt}`, token)
        .then(() => registered.push(token));

      await Promise.all([failingReservation, registration]);
    }

    const stored = await harness.dataSource.getRepository(FcmToken).find();
    expect(registered).toHaveLength(20);
    expect(stored.map((row) => row.token).sort()).toEqual([...registered].sort());
  });

  it("saves an expiry warning for every reservation when a sale sells out", async () => {
    const concert = await harness.createConcert(10);
    const reservations = new ReservationService(
      harness.dataSource,
      harness.notificationService
    );

    const outcomes = await Promise.allSettled(
      Array.from({ length: 40 }, (_, index) =>
        reservations.reserveTickets({
          concertId: concert.id,
          userId: `buyer-${index}`,
          quantity: 1
        })
      )
    );

    const reserved = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const tickets = await harness.dataSource
      .getRepository(Ticket)
      .countBy({ concertId: concert.id });
    const warnings = await harness.dataSource
      .getRepository(TicketNotification)
      .count();

    expect(reserved).toHaveLength(10);
    expect(tickets).toBe(10);
    expect(warnings).toBe(10);
  });
});
