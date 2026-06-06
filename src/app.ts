import express, { NextFunction, Request, Response } from "express";
import path from "node:path";
import swaggerUi from "swagger-ui-express";
import { DataSource } from "typeorm";
import { RedisClientType } from "redis";
import {
  FirebaseAuthVerifier,
  getPublicFirebaseConfig
} from "./auth/firebase-admin";
import { Concert } from "./entities/Concert";
import { Ticket } from "./entities/Ticket";
import { swaggerSpec } from "./docs/swagger";
import { toTicketDto, toTicketDtos } from "./dto/ticket.dto";
import { AppError, ConcurrencyError } from "./errors/AppError";
import { errorMiddleware } from "./middleware/error.middleware";
import { correlationIdMiddleware } from "./middleware/correlation-id.middleware";
import {
  AuthenticatedRequest,
  requireFirebaseAuth
} from "./middleware/firebase-auth.middleware";
import { createReservationRateLimiter } from "./middleware/rate-limit.middleware";
import { requestLoggerMiddleware } from "./middleware/request-logger.middleware";
import { validateBody } from "./middleware/validate.middleware";
import { logger } from "./logger/logger";
import { CleanupService } from "./services/cleanup.service";
import { NotificationService } from "./services/notification.service";
import { PurchaseService } from "./services/purchase.service";
import { ReservationService } from "./services/reservation.service";
import {
  authenticatedPurchaseTicketSchema,
  authenticatedReserveTicketSchema,
  fcmTokenSchema,
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
  firebaseAuthVerifier?: FirebaseAuthVerifier;
  notificationService?: NotificationService;
}

export function createApp(
  dataSource: DataSource,
  options: CreateAppOptions = {}
) {
  const app = express();
  const notificationService =
    options.notificationService ?? new NotificationService(dataSource);
  const reservationService = new ReservationService(
    dataSource,
    notificationService
  );
  const purchaseService = new PurchaseService(dataSource);
  const cleanupService = new CleanupService(dataSource);
  const firebaseAuth = requireFirebaseAuth(options.firebaseAuthVerifier);
  const shouldEnableRateLimit = options.enableRateLimit ?? false;
  const reservationRateLimiter =
    shouldEnableRateLimit && options.redisClient
      ? createReservationRateLimiter(options.redisClient, options.rateLimitPrefix)
      : (_request: Request, _response: Response, next: NextFunction) => next();

  app.use(correlationIdMiddleware);
  app.use(requestLoggerMiddleware);
  app.use(express.json());

  const publicPath = path.join(__dirname, "public");
  app.get("/app", (_request, response) => response.redirect("/app/"));
  app.use("/app", express.static(publicPath));

  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  app.use("/api/v1/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  app.get("/api-docs.json", (_request, response) => {
    response.json(swaggerSpec);
  });

  const apiIndexHandler = (_request: Request, response: Response) => {
    response.json({
      name: "High-Demand Ticket Reservation Backend",
      status: "ok",
      endpoints: {
        health: "GET /health",
        healthV1: "GET /api/v1/health",
        concerts: "GET /concerts",
        concertsV1: "GET /api/v1/concerts",
        tickets: "GET /tickets",
        ticketsV1: "GET /api/v1/tickets",
        reserve: "POST /reserve",
        reserveV1: "POST /api/v1/reserve",
        createTicket: "POST /tickets",
        createTicketV1: "POST /api/v1/tickets",
        purchase: "POST /purchase",
        purchaseV1: "POST /api/v1/purchase",
        purchaseOptimistic: "POST /tickets/:ticketId/purchase-optimistic",
        purchaseOptimisticV1:
          "POST /api/v1/tickets/:ticketId/purchase-optimistic",
        purchasePessimistic: "POST /tickets/:ticketId/purchase-pessimistic",
        purchasePessimisticV1:
          "POST /api/v1/tickets/:ticketId/purchase-pessimistic",
        cleanup: "POST /cleanup",
        cleanupV1: "POST /api/v1/cleanup",
        app: "GET /app",
        firebaseConfig: "GET /api/v1/firebase-config",
        myTickets: "GET /api/v1/me/tickets",
        fcmTokens: "POST /api/v1/me/fcm-tokens",
        docs: "GET /api-docs",
        docsV1: "GET /api/v1/docs"
      }
    });
  };

  app.get("/", apiIndexHandler);
  app.get("/api/v1", apiIndexHandler);

  const healthHandler = (_request: Request, response: Response) => {
    response.json({ status: "ok" });
  };

  app.get("/health", healthHandler);
  app.get("/api/v1/health", healthHandler);

  app.get("/api/v1/firebase-config", (_request, response) => {
    response.json(getPublicFirebaseConfig());
  });

  const concertsHandler = asyncHandler(async (_request, response) => {
      const concerts = await dataSource.getRepository(Concert).find({
        order: { id: "ASC" }
      });

      response.json(concerts);
    });

  app.get("/concerts", concertsHandler);
  app.get("/api/v1/concerts", concertsHandler);

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
  const ticketsHandler = asyncHandler(async (_request, response) => {
      const tickets = await dataSource.getRepository(Ticket).find({
        order: { id: "ASC" }
      });

      response.json(toTicketDtos(tickets));
    });

  app.get("/tickets", ticketsHandler);
  app.get("/api/v1/tickets", ticketsHandler);

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
    "/api/v1/reserve",
    firebaseAuth,
    reservationRateLimiter,
    validateBody(authenticatedReserveTicketSchema),
    asyncHandler(async (request, response) => {
      const authRequest = request as AuthenticatedRequest;
      const ticket = await reservationService.reserveTickets({
        ...request.body,
        userId: authRequest.authUser.uid
      });
      response.status(201).json({ ticket: toTicketDto(ticket) });
    })
  );

  app.post(
    "/tickets",
    reservationRateLimiter,
    validateBody(reserveTicketSchema),
    reserveHandler
  );
  app.post(
    "/api/v1/tickets",
    firebaseAuth,
    reservationRateLimiter,
    validateBody(authenticatedReserveTicketSchema),
    asyncHandler(async (request, response) => {
      const authRequest = request as AuthenticatedRequest;
      const ticket = await reservationService.reserveTickets({
        ...request.body,
        userId: authRequest.authUser.uid
      });
      response.status(201).json({ ticket: toTicketDto(ticket) });
    })
  );

  const purchaseHandler = asyncHandler(async (request, response) => {
      const ticket = await purchaseService.purchaseTicket(request.body);
      response.json({ ticket: toTicketDto(ticket) });
    });

  app.post("/purchase", validateBody(purchaseTicketSchema), purchaseHandler);
  app.post(
    "/api/v1/purchase",
    firebaseAuth,
    validateBody(authenticatedPurchaseTicketSchema),
    asyncHandler(async (request, response) => {
      const authRequest = request as AuthenticatedRequest;
      const ticket = await purchaseService.purchaseTicket({
        ticketId: request.body.ticketId,
        userId: authRequest.authUser.uid
      });
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
  app.post(
    "/api/v1/tickets/:ticketId/purchase-optimistic",
    firebaseAuth,
    validateBody(authenticatedPurchaseTicketSchema.omit({ ticketId: true })),
    asyncHandler(async (request, response) => {
      const authRequest = request as AuthenticatedRequest;
      const ticketId = Number(request.params.ticketId);
      const ticket = await purchaseService.purchaseTicketOptimistic({
        ticketId,
        userId: authRequest.authUser.uid
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
    "/api/v1/tickets/:ticketId/purchase-pessimistic",
    firebaseAuth,
    validateBody(authenticatedPurchaseTicketSchema.omit({ ticketId: true })),
    asyncHandler(async (request, response) => {
      const authRequest = request as AuthenticatedRequest;
      const ticketId = Number(request.params.ticketId);
      const ticket = await purchaseService.purchaseTicketPessimistic({
        ticketId,
        userId: authRequest.authUser.uid
      });

      response.json({ ticket: toTicketDto(ticket) });
    })
  );

  /**
   * @openapi
   * /me/tickets:
   *   get:
   *     summary: List tickets owned by the authenticated Firebase user.
   *     security:
   *       - FirebaseBearerAuth: []
   *     responses:
   *       200:
   *         description: Ticket DTOs for the current user.
   *       401:
   *         description: Missing or invalid Firebase token.
   */
  app.get(
    "/api/v1/me/tickets",
    firebaseAuth,
    asyncHandler(async (request, response) => {
      const authRequest = request as AuthenticatedRequest;
      const tickets = await dataSource.getRepository(Ticket).find({
        where: { userId: authRequest.authUser.uid },
        order: { id: "ASC" }
      });

      response.json(toTicketDtos(tickets));
    })
  );

  /**
   * @openapi
   * /me/fcm-tokens:
   *   post:
   *     summary: Register this browser's Firebase Cloud Messaging token.
   *     security:
   *       - FirebaseBearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/FcmTokenRequest'
   *     responses:
   *       201:
   *         description: FCM token registered.
   *       401:
   *         description: Missing or invalid Firebase token.
   */
  app.post(
    "/api/v1/me/fcm-tokens",
    firebaseAuth,
    validateBody(fcmTokenSchema),
    asyncHandler(async (request, response) => {
      const authRequest = request as AuthenticatedRequest;
      const token = await notificationService.registerFcmToken(
        authRequest.authUser.uid,
        request.body.token
      );

      response.status(201).json({
        token: {
          id: token.id,
          userId: token.userId,
          createdAt: token.createdAt,
          updatedAt: token.updatedAt
        }
      });
    })
  );

  app.post(
    "/api/v1/debug/concurrency-error",
    asyncHandler(async (request) => {
      const debugSecret = process.env.DEBUG_SECRET;

      if (!debugSecret) {
        throw new AppError(404, "NOT_FOUND", "Not found");
      }

      if (request.header("X-Debug-Secret") !== debugSecret) {
        throw new AppError(403, "FORBIDDEN", "Forbidden");
      }

      logger.warn(
        { ip: request.ip },
        "Manual ConcurrencyError triggered for Sentry verification"
      );
      throw new ConcurrencyError(
        "Manual ConcurrencyError test triggered for Sentry verification"
      );
    })
  );

  const cleanupHandler = asyncHandler(async (_request, response) => {
      const cleanupResult = await cleanupService.cleanupExpiredReservations();
      response.json(cleanupResult);
    });

  app.post("/cleanup", cleanupHandler);
  app.post("/api/v1/cleanup", cleanupHandler);

  app.use(errorMiddleware);

  return app;
}
