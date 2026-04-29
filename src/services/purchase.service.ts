import { DataSource } from "typeorm";
import { Ticket } from "../entities/Ticket";
import { TicketStatus } from "../entities/TicketStatus";
import { AppError } from "../errors/AppError";
import { formatSqliteDate } from "../utils/date";
import { runWriteTransaction } from "../utils/transaction";

export interface PurchaseTicketInput {
  ticketId: number;
  userId: string;
}

export class PurchaseService {
  constructor(private readonly dataSource: DataSource) {}

  async purchaseTicket(input: PurchaseTicketInput): Promise<Ticket> {
    this.validateInput(input);

    return runWriteTransaction(this.dataSource, async (queryRunner) => {
      const now = new Date();
      const updateResult = await queryRunner.manager
        .createQueryBuilder()
        .update(Ticket)
        .set({ status: TicketStatus.Completed, expiresAt: null })
        .where("id = :ticketId", { ticketId: input.ticketId })
        .andWhere("userId = :userId", { userId: input.userId.trim() })
        .andWhere("status = :status", { status: TicketStatus.Pending })
        .andWhere("expiresAt > :now", { now: formatSqliteDate(now) })
        .execute();

      if ((updateResult.affected ?? 0) === 0) {
        throw new AppError(
          409,
          "Reservation is not pending, has expired, or belongs to another user"
        );
      }

      const ticket = await queryRunner.manager.findOneByOrFail(Ticket, {
        id: input.ticketId
      });

      return ticket;
    });
  }

  private validateInput(input: PurchaseTicketInput): void {
    if (!Number.isInteger(input.ticketId) || input.ticketId <= 0) {
      throw new AppError(400, "ticketId must be a positive integer");
    }

    if (typeof input.userId !== "string" || input.userId.trim().length === 0) {
      throw new AppError(400, "userId is required");
    }
  }
}
