import type { DataSource } from "typeorm";
import { Concert } from "../entities/Concert";
import { Ticket } from "../entities/Ticket";
import { TicketStatus } from "../entities/TicketStatus";
import { AppError } from "../errors/AppError";
import type { NotificationService } from "./notification.service";
import { formatSqliteDate, reservationExpiry } from "../utils/date";
import { runWriteTransaction } from "../utils/transaction";

export interface ReserveTicketInput {
  concertId: number;
  userId: string;
  category?: string;
  quantity: number;
}

/** Seats one user may hold as unexpired PENDING tickets for one concert. */
export const MAX_HELD_SEATS_PER_CONCERT = 5;

export interface ReservationOptions {
  forceTicketSaveFailure?: boolean;
}

export class ReservationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly notificationService?: NotificationService
  ) {}

  async reserveTickets(
    input: ReserveTicketInput,
    options: ReservationOptions = {}
  ): Promise<Ticket> {
    this.validateInput(input);

    return runWriteTransaction(this.dataSource, async (queryRunner) => {
      const held = await queryRunner.manager
        .createQueryBuilder(Ticket, "ticket")
        .select("COALESCE(SUM(ticket.quantity), 0)", "seats")
        .where("ticket.concertId = :concertId", { concertId: input.concertId })
        .andWhere("ticket.userId = :userId", { userId: input.userId.trim() })
        .andWhere("ticket.status = :status", { status: TicketStatus.Pending })
        .andWhere("ticket.expiresAt > :now", {
          now: formatSqliteDate(new Date())
        })
        .getRawOne<{ seats: number }>();

      if (Number(held?.seats ?? 0) + input.quantity > MAX_HELD_SEATS_PER_CONCERT) {
        throw new AppError(
          409,
          "HOLD_LIMIT_REACHED",
          `You can hold at most ${MAX_HELD_SEATS_PER_CONCERT} seats for this concert at a time`
        );
      }

      const updateResult = await queryRunner.manager
        .createQueryBuilder()
        .update(Concert)
        .set({ availableStock: () => `"availableStock" - :reservedQuantity` })
        .where("id = :concertId", { concertId: input.concertId })
        .andWhere("availableStock >= :quantity", { quantity: input.quantity })
        .setParameter("reservedQuantity", input.quantity)
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

      const savedTicket = await queryRunner.manager.save(Ticket, ticket);
      await this.notificationService?.scheduleExpirationWarning(
        queryRunner.manager,
        savedTicket
      );
      return savedTicket;
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

    if (
      !Number.isInteger(input.quantity) ||
      input.quantity < 1 ||
      input.quantity > 5
    ) {
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
