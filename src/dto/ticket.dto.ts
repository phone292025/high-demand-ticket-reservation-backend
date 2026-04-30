import { Ticket } from "../entities/Ticket";

export interface TicketDto {
  id: number;
  concertId: number;
  userId: string;
  status: string;
  category: string;
  quantity: number;
  expiresAt: Date | null;
  createdAt: Date;
}

export function toTicketDto(ticket: Ticket): TicketDto {
  return {
    id: ticket.id,
    concertId: ticket.concertId,
    userId: ticket.userId,
    status: ticket.status,
    category: ticket.category,
    quantity: ticket.quantity,
    expiresAt: ticket.expiresAt,
    createdAt: ticket.createdAt
  };
}

export function toTicketDtos(tickets: Ticket[]): TicketDto[] {
  return tickets.map(toTicketDto);
}
