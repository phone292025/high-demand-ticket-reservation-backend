import express, { NextFunction, Request, Response } from "express";
import swaggerUi from "swagger-ui-express";
import { DataSource } from "typeorm";
import { RedisClientType } from "redis";
import { Concert } from "./entities/Concert";
import { Ticket } from "./entities/Ticket";
import { swaggerSpec } from "./docs/swagger";
import { toTicketDto, toTicketDtos } from "./dto/ticket.dto";
import { errorMiddleware } from "./middleware/error.middleware";
import { correlationIdMiddleware } from "./middleware/correlation-id.middleware";
import { createReservationRateLimiter } from "./middleware/rate-limit.middleware";
import { requestLoggerMiddleware } from "./middleware/request-logger.middleware";
import { validateBody } from "./middleware/validate.middleware";
import { CleanupService } from "./services/cleanup.service";
import { PurchaseService } from "./services/purchase.service";
import { ReservationService } from "./services/reservation.service";
import {
  purchaseByRouteSchema,
  purchaseTicketSchema,
  reserveTicketSchema
} from "./validation/ticket.schemas";

type AsyncRoute = (
  request: Request,
  response: Response,
  next: NextFunction
) => Promise<void>;

function asyncHandler(route: AsyncRoute) {
  return (request: Request, response: Response, next: NextFunction) => {
    route(request, response, next).catch(next);
  };
}

export interface CreateAppOptions {
  enableRateLimit?: boolean;
  redisClient?: RedisClientType;
  rateLimitPrefix?: string;
}

export function createApp(
  dataSource: DataSource,
  options: CreateAppOptions = {}
) {
  const app = express();
  const reservationService = new ReservationService(dataSource);
  const purchaseService = new PurchaseService(dataSource);
  const cleanupService = new CleanupService(dataSource);
  const shouldEnableRateLimit = options.enableRateLimit ?? false;
  const reservationRateLimiter =
    shouldEnableRateLimit && options.redisClient
      ? createReservationRateLimiter(options.redisClient, options.rateLimitPrefix)
      : (_request: Request, _response: Response, next: NextFunction) => next();

  app.use(correlationIdMiddleware);
  app.use(requestLoggerMiddleware);
  app.use(express.json());

  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  app.get("/api-docs.json", (_request, response) => {
    response.json(swaggerSpec);
  });

  app.get("/", (_request, response) => {
    response.json({
      name: "High-Demand Ticket Reservation Backend",
      status: "ok",
      endpoints: {
        health: "GET /health",
        concerts: "GET /concerts",
        tickets: "GET /tickets",
        reserve: "POST /reserve",
        createTicket: "POST /tickets",
        purchase: "POST /purchase",
        purchaseOptimistic: "POST /tickets/:ticketId/purchase-optimistic",
        purchasePessimistic: "POST /tickets/:ticketId/purchase-pessimistic",
        cleanup: "POST /cleanup"
      }
    });
  });

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.get(
    "/concerts",
    asyncHandler(async (_request, response) => {
      const concerts = await dataSource.getRepository(Concert).find({
        order: { id: "ASC" }
      });

      response.json(concerts);
    })
  );

  /**
   * @openapi
   * /tickets:
   *   get:
   *     summary: List tickets with safe response DTOs.
   *     responses:
   *       200:
   *         description: Safe ticket DTO list.
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/TicketDto'
   *   post:
   *     summary: Create a pending ticket reservation. Alias of POST /reserve.
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/ReserveRequest'
   *     responses:
   *       201:
   *         description: Ticket reserved.
   *       400:
   *         description: Validation error.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       409:
   *         description: Sold out.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       429:
   *         description: Rate limit exceeded.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  app.get(
    "/tickets",
    asyncHandler(async (_request, response) => {
      const tickets = await dataSource.getRepository(Ticket).find({
        order: { id: "ASC" }
      });

      response.json(toTicketDtos(tickets));
    })
  );

  const reserveHandler = asyncHandler(async (request, response) => {
    const ticket = await reservationService.reserveTickets(request.body);
    response.status(201).json({ ticket: toTicketDto(ticket) });
  });

  /**
   * @openapi
   * /reserve:
   *   post:
   *     summary: Reserve tickets for five minutes.
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/ReserveRequest'
   *     responses:
   *       201:
   *         description: Ticket reserved.
   *       400:
   *         description: Validation error.
   *       409:
   *         description: Sold out.
   *       429:
   *         description: Rate limit exceeded.
   */
  app.post(
    "/reserve",
    reservationRateLimiter,
    validateBody(reserveTicketSchema),
    reserveHandler
  );

  app.post(
    "/tickets",
    reservationRateLimiter,
    validateBody(reserveTicketSchema),
    reserveHandler
  );

  app.post(
    "/purchase",
    validateBody(purchaseTicketSchema),
    asyncHandler(async (request, response) => {
      const ticket = await purchaseService.purchaseTicket(request.body);
      response.json({ ticket: toTicketDto(ticket) });
    })
  );

  /**
   * @openapi
   * /tickets/{ticketId}/purchase-optimistic:
   *   post:
   *     summary: Purchase with optimistic locking.
   *     parameters:
   *       - in: path
   *         name: ticketId
   *         required: true
   *         schema:
   *           type: integer
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/PurchaseRequest'
   *     responses:
   *       200:
   *         description: Ticket completed.
   *       409:
   *         description: Lock conflict.
   */
  app.post(
    "/tickets/:ticketId/purchase-optimistic",
    validateBody(purchaseByRouteSchema),
    asyncHandler(async (request, response) => {
      const ticketId = Number(request.params.ticketId);
      const ticket = await purchaseService.purchaseTicketOptimistic({
        ticketId,
        userId: request.body.userId
      });

      response.json({ ticket: toTicketDto(ticket) });
    })
  );

  /**
   * @openapi
   * /tickets/{ticketId}/purchase-pessimistic:
   *   post:
   *     summary: Purchase with pessimistic locking when supported by the database.
   *     parameters:
   *       - in: path
   *         name: ticketId
   *         required: true
   *         schema:
   *           type: integer
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/PurchaseRequest'
   *     responses:
   *       200:
   *         description: Ticket completed.
   *       409:
   *         description: Lock conflict.
   */
  app.post(
    "/tickets/:ticketId/purchase-pessimistic",
    validateBody(purchaseByRouteSchema),
    asyncHandler(async (request, response) => {
      const ticketId = Number(request.params.ticketId);
      const ticket = await purchaseService.purchaseTicketPessimistic({
        ticketId,
        userId: request.body.userId
      });

      response.json({ ticket: toTicketDto(ticket) });
    })
  );

  app.post(
    "/cleanup",
    asyncHandler(async (_request, response) => {
      const cleanupResult = await cleanupService.cleanupExpiredReservations();
      response.json(cleanupResult);
    })
  );

  app.use(errorMiddleware);

  return app;
}
