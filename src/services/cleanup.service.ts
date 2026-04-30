import { DataSource, In } from "typeorm";
import { Concert } from "../entities/Concert";
import { Ticket } from "../entities/Ticket";
import { TicketStatus } from "../entities/TicketStatus";
import { formatSqliteDate } from "../utils/date";
import { runWriteTransaction } from "../utils/transaction";

export interface CleanupResult {
  expiredCount: number;
  releasedByConcert: Record<number, number>;
}

export class CleanupService {
  constructor(private readonly dataSource: DataSource) {}

  async cleanupExpiredReservations(now: Date = new Date()): Promise<CleanupResult> {
    return runWriteTransaction(this.dataSource, async (queryRunner) => {
      const expiredTickets = await queryRunner.manager
        .createQueryBuilder(Ticket, "ticket")
        .select(["ticket.id", "ticket.concertId", "ticket.quantity"])
        .where("ticket.status = 'PENDING'")
        .andWhere("ticket.expiresAt < :now", { now: formatSqliteDate(now) })
        .getMany();

      if (expiredTickets.length === 0) {
        return { expiredCount: 0, releasedByConcert: {} };
      }

      const ticketIds = expiredTickets.map((ticket) => ticket.id);
      const releasedByConcert = expiredTickets.reduce<Record<number, number>>(
        (counts, ticket) => {
          counts[ticket.concertId] =
            (counts[ticket.concertId] ?? 0) + ticket.quantity;
          return counts;
        },
        {}
      );

      await queryRunner.manager.update(
        Ticket,
        { id: In(ticketIds), status: TicketStatus.Pending },
        { status: TicketStatus.Expired }
      );

      for (const [concertId, releasedCount] of Object.entries(releasedByConcert)) {
        await queryRunner.manager
          .createQueryBuilder()
          .update(Concert)
          .set({
            availableStock: () =>
              `CASE
                WHEN "availableStock" + ${Number(releasedCount)} > "totalStock"
                THEN "totalStock"
                ELSE "availableStock" + ${Number(releasedCount)}
              END`
          })
          .where("id = :concertId", { concertId: Number(concertId) })
          .execute();
      }

      return {
        expiredCount: expiredTickets.length,
        releasedByConcert
      };
    });
  }
}
