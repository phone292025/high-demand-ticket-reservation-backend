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
  quantity: number;
}

export interface ReservationOptions {
  forceTicketSaveFailure?: boolean;
}

export class ReservationService {
  constructor(private readonly dataSource: DataSource) {}

  async reserveTickets(
    input: ReserveTicketInput,
    options: ReservationOptions = {}
  ): Promise<Ticket> {
    this.validateInput(input);

    return runWriteTransaction(this.dataSource, async (queryRunner) => {
      const updateResult = await queryRunner.manager
        .createQueryBuilder()
        .update(Concert)
        .set({ availableStock: () => `"availableStock" - ${input.quantity}` })
        .where("id = :concertId", { concertId: input.concertId })
        .andWhere("availableStock >= :quantity", { quantity: input.quantity })
        .execute();

      if ((updateResult.affected ?? 0) === 0) {
        const concertExists = await queryRunner.manager.exists(Concert, {
          where: { id: input.concertId }
        });

        if (!concertExists) {
          throw new AppError(404, "NOT_FOUND", "Concert not found");
        }

        throw new AppError(409, "SOLD_OUT", "Sold Out");
      }

      const ticket = queryRunner.manager.create(Ticket, {
        concertId: input.concertId,
        userId: input.userId.trim(),
        status: options.forceTicketSaveFailure
          ? ("INVALID_STATUS" as TicketStatus)
          : TicketStatus.Pending,
        expiresAt: reservationExpiry(),
        category: input.category?.trim() || "General",
        quantity: input.quantity
      });

      return queryRunner.manager.save(Ticket, ticket);
    });
  }

  async reserveTicket(
    input: ReserveTicketInput,
    options: ReservationOptions = {}
  ): Promise<Ticket> {
    return this.reserveTickets(input, options);
  }

  private validateInput(input: ReserveTicketInput): void {
    if (!Number.isInteger(input.concertId) || input.concertId <= 0) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "concertId must be a positive integer"
      );
    }

    if (typeof input.userId !== "string" || input.userId.trim().length === 0) {
      throw new AppError(400, "VALIDATION_ERROR", "userId is required");
    }

    if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 5) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "quantity must be an integer between 1 and 5"
      );
    }

    if (
      input.category !== undefined &&
      (typeof input.category !== "string" || input.category.trim().length === 0)
    ) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "category must be a non-empty string"
      );
    }
  }
}
