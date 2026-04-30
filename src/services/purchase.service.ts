import { DataSource } from "typeorm";
import { Ticket } from "../entities/Ticket";
import { TicketStatus } from "../entities/TicketStatus";
import { AppError } from "../errors/AppError";
import { logger } from "../logger/logger";
import { formatSqliteDate } from "../utils/date";
import { runWriteTransaction } from "../utils/transaction";

export interface PurchaseTicketInput {
  ticketId: number;
  userId: string;
}

export class PurchaseService {
  constructor(private readonly dataSource: DataSource) {}

  async purchaseTicket(input: PurchaseTicketInput): Promise<Ticket> {
    return this.purchaseTicketOptimistic(input);
  }

  async purchaseTicketOptimistic(input: PurchaseTicketInput): Promise<Ticket> {
    this.validateInput(input);

    return runWriteTransaction(this.dataSource, async (queryRunner) => {
      const now = new Date();
      const ticket = await queryRunner.manager.findOneBy(Ticket, {
        id: input.ticketId,
        userId: input.userId.trim()
      });

      if (!ticket) {
        throw new AppError(
          409,
          "LOCK_CONFLICT",
          "Reservation is not pending, has expired, or belongs to another user"
        );
      }

      const updateResult = await queryRunner.manager
        .createQueryBuilder()
        .update(Ticket)
        .set({
          status: TicketStatus.Completed,
          expiresAt: null,
          version: () => `"version" + 1`
        })
        .where("id = :ticketId", { ticketId: input.ticketId })
        .andWhere("userId = :userId", { userId: input.userId.trim() })
        .andWhere("status = :status", { status: TicketStatus.Pending })
        .andWhere("version = :version", { version: ticket.version })
        .andWhere("expiresAt > :now", { now: formatSqliteDate(now) })
        .execute();

      if ((updateResult.affected ?? 0) === 0) {
        throw new AppError(
          409,
          "LOCK_CONFLICT",
          "Reservation is not pending, has expired, or belongs to another user"
        );
      }

      const updatedTicket = await queryRunner.manager.findOneByOrFail(Ticket, {
        id: input.ticketId
      });

      return updatedTicket;
    });
  }

  async purchaseTicketPessimistic(input: PurchaseTicketInput): Promise<Ticket> {
    this.validateInput(input);

    return runWriteTransaction(this.dataSource, async (queryRunner) => {
      const now = new Date();
      const createTicketQuery = () =>
        queryRunner.manager
          .createQueryBuilder(Ticket, "ticket")
          .where("ticket.id = :ticketId", { ticketId: input.ticketId })
          .andWhere("ticket.userId = :userId", { userId: input.userId.trim() });

      let ticket: Ticket | null;

      try {
        ticket = await createTicketQuery().setLock("pessimistic_write").getOne();
      } catch (error) {
        logger.warn(
          {
            error: error instanceof Error ? error.name : "LOCK_UNSUPPORTED",
            message: error instanceof Error ? error.message : String(error)
          },
          "SQLite does not provide true row-level pessimistic locking; using serialized transaction fallback"
        );
        ticket = await createTicketQuery().getOne();
      }

      if (
        !ticket ||
        ticket.status !== TicketStatus.Pending ||
        !ticket.expiresAt ||
        ticket.expiresAt <= now
      ) {
        throw new AppError(
          409,
          "LOCK_CONFLICT",
          "Reservation is not pending, has expired, or belongs to another user"
        );
      }

      ticket.status = TicketStatus.Completed;
      ticket.expiresAt = null;

      return queryRunner.manager.save(Ticket, ticket);
    });
  }

  private validateInput(input: PurchaseTicketInput): void {
    if (!Number.isInteger(input.ticketId) || input.ticketId <= 0) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "ticketId must be a positive integer"
      );
    }

    if (typeof input.userId !== "string" || input.userId.trim().length === 0) {
      throw new AppError(400, "VALIDATION_ERROR", "userId is required");
    }
  }
}
