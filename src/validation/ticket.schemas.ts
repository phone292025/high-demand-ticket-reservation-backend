import { z } from "zod";

export const reserveTicketSchema = z
  .object({
    concertId: z.number().int().positive(),
    userId: z.string().trim().min(1),
    category: z.string().trim().min(1).default("General"),
    quantity: z.number().int().min(1).max(5)
  })
  .strict();

export const authenticatedReserveTicketSchema = z
  .object({
    concertId: z.number().int().positive(),
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

export const authenticatedPurchaseTicketSchema = z
  .object({
    ticketId: z.number().int().positive()
  })
  .strict();

export const purchaseByRouteSchema = z
  .object({
    userId: z.string().trim().min(1)
  })
  .strict();

export const fcmTokenSchema = z
  .object({
    token: z.string().trim().min(20).max(4096)
  })
  .strict();

export type ReserveTicketBody = z.infer<typeof reserveTicketSchema>;
export type AuthenticatedReserveTicketBody = z.infer<
  typeof authenticatedReserveTicketSchema
>;
export type PurchaseTicketBody = z.infer<typeof purchaseTicketSchema>;
export type AuthenticatedPurchaseTicketBody = z.infer<
  typeof authenticatedPurchaseTicketSchema
>;
export type PurchaseByRouteBody = z.infer<typeof purchaseByRouteSchema>;
