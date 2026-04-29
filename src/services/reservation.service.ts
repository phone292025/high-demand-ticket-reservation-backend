import { DataSource } from "typeorm";
import { Concert } from "../entities/Concert";
import { Ticket } from "../entities/Ticket";
import { TicketStatus } from "../entities/TicketStatus";
import { AppError } from "../errors/AppError";
import { reservationExpiry } from "../utils/date";
import { runWriteTransaction } from "../utils/transaction";

export interface ReserveTicketInput {
  concertId: number;
  userId: string;
  category?: string;
}

export interface ReservationOptions {
  forceTicketSaveFailure?: boolean;
}

export class ReservationService {
  constructor(private readonly dataSource: DataSource) {}

  async reserveTicket(
    input: ReserveTicketInput,
    options: ReservationOptions = {}
  ): Promise<Ticket> {
    this.validateInput(input);

    return runWriteTransaction(this.dataSource, async (queryRunner) => {
      const updateResult = await queryRunner.manager
        .createQueryBuilder()
        .update(Concert)
        .set({ availableStock: () => `"availableStock" - 1` })
        .where("id = :concertId", { concertId: input.concertId })
        .andWhere("availableStock > 0")
        .execute();

      if ((updateResult.affected ?? 0) === 0) {
        const concertExists = await queryRunner.manager.exists(Concert, {
          where: { id: input.concertId }
        });

        if (!concertExists) {
          throw new AppError(404, "Concert not found");
        }

        throw new AppError(409, "Sold Out");
      }

      const ticket = queryRunner.manager.create(Ticket, {
        concertId: input.concertId,
        userId: input.userId.trim(),
        status: options.forceTicketSaveFailure
          ? ("INVALID_STATUS" as TicketStatus)
          : TicketStatus.Pending,
        expiresAt: reservationExpiry(),
        category: input.category?.trim() || "General"
      });

      return queryRunner.manager.save(Ticket, ticket);
    });
  }

  private validateInput(input: ReserveTicketInput): void {
    if (!Number.isInteger(input.concertId) || input.concertId <= 0) {
      throw new AppError(400, "concertId must be a positive integer");
    }

    if (typeof input.userId !== "string" || input.userId.trim().length === 0) {
      throw new AppError(400, "userId is required");
    }

    if (
      input.category !== undefined &&
      (typeof input.category !== "string" || input.category.trim().length === 0)
    ) {
      throw new AppError(400, "category must be a non-empty string");
    }
  }
}
