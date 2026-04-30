import { z } from "zod";

export const reserveTicketSchema = z
  .object({
    concertId: z.number().int().positive(),
    userId: z.string().trim().min(1),
    category: z.string().trim().min(1).default("General"),
    quantity: z.number().int().min(1).max(5)
  })
  .strict();

export const purchaseTicketSchema = z
  .object({
    ticketId: z.number().int().positive(),
    userId: z.string().trim().min(1)
  })
  .strict();

export const purchaseByRouteSchema = z
  .object({
    userId: z.string().trim().min(1)
  })
  .strict();

export type ReserveTicketBody = z.infer<typeof reserveTicketSchema>;
export type PurchaseTicketBody = z.infer<typeof purchaseTicketSchema>;
export type PurchaseByRouteBody = z.infer<typeof purchaseByRouteSchema>;
