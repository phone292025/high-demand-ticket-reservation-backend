import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import express from "express";
import helmet from "helmet";
import path from "node:path";
import swaggerUi from "swagger-ui-express";
import type { DataSource } from "typeorm";
import type { RedisClientType } from "redis";
import type { FirebaseAuthVerifier } from "./auth/firebase-config";
import { getPublicFirebaseConfig } from "./auth/firebase-config";
import { Concert } from "./entities/Concert";
import { Ticket } from "./entities/Ticket";
import { swaggerSpec } from "./docs/swagger";
import { toTicketDto, toTicketDtos } from "./dto/ticket.dto";
import { AppError, ConcurrencyError } from "./errors/AppError";
import { errorMiddleware } from "./middleware/error.middleware";
import { correlationIdMiddleware } from "./middleware/correlation-id.middleware";
import type { AuthenticatedRequest } from "./middleware/firebase-auth.middleware";
import { requireFirebaseAuth } from "./middleware/firebase-auth.middleware";
import {
  createGlobalRateLimiter,
  createPurchaseRateLimiter,
  createReservationRateLimiter
} from "./middleware/rate-limit.middleware";
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

function passThrough(_request: Request, _response: Response, next: NextFunction) {
  next();
}

/** Constant-time comparison so the secret cannot be recovered by timing. */
function secretsMatch(provided: string | undefined, expected: string): boolean {
  if (!provided) {
    return false;
  }

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
}

/**
 * The PWA loads the Firebase compat SDK from gstatic and talks to Google's auth
 * and messaging endpoints, so it needs an explicit allowlist. Swagger UI ships
 * inline scripts of its own and is deliberately left outside this policy.
 */
const appContentSecurityPolicy = helmet.contentSecurityPolicy({
  useDefaults: false,
  directives: {
    "default-src": ["'self'"],
    "script-src": ["'self'", "https://www.gstatic.com"],
    "connect-src": [
      "'self'",
      "https://*.googleapis.com",
      "https://*.google.com",
      "https://*.firebaseio.com"
    ],
    "frame-src": ["https://*.firebaseapp.com", "https://accounts.google.com"],
    "img-src": ["'self'", "data:"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "worker-src": ["'self'"],
    "manifest-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"]
  }
});

export interface CreateAppOptions {
  enableRateLimit?: boolean;
  enableLegacyDemoRoutes?: boolean;
  enablePublicCleanup?: boolean;
  redisClient?: RedisClientType;
  rateLimitPrefix?: string;
  firebaseAuthVerifier?: FirebaseAuthVerifier;
  notificationService?: NotificationService;
  /**
   * Proxy hops to trust for client IP resolution. Behind the shipped nginx this
   * must be 1 — with the default of 0, every request appears to come from the
   * proxy and the whole internet shares a single rate-limit bucket.
   */
  trustProxy?: number | boolean | string;
}

export function createApp(dataSource: DataSource, options: CreateAppOptions = {}) {
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
  const enableLegacyDemoRoutes =
    options.enableLegacyDemoRoutes ??
    process.env.ENABLE_LEGACY_DEMO_ROUTES === "true";
  const enablePublicCleanup =
    options.enablePublicCleanup ?? process.env.ENABLE_PUBLIC_CLEANUP === "true";

  const trustProxy =
    options.trustProxy ?? Number(process.env.TRUST_PROXY_HOPS ?? 0);
  app.set("trust proxy", trustProxy);
  app.disable("x-powered-by");

  const globalRateLimiter: RequestHandler = shouldEnableRateLimit
    ? createGlobalRateLimiter(options.redisClient, options.rateLimitPrefix)
    : passThrough;
  const reservationRateLimiter: RequestHandler = shouldEnableRateLimit
    ? createReservationRateLimiter(options.redisClient, options.rateLimitPrefix)
    : passThrough;
  const purchaseRateLimiter: RequestHandler = shouldEnableRateLimit
    ? createPurchaseRateLimiter(options.redisClient, options.rateLimitPrefix)
    : passThrough;

  app.use(
    helmet({
      // Swagger UI injects inline scripts; /app gets its own policy below.
      contentSecurityPolicy: false,
      // Firebase signInWithPopup needs the popup to reach its opener, which a
      // bare same-origin COOP would block.
      crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" }
    })
  );
  app.use(correlationIdMiddleware);
  app.use(requestLoggerMiddleware);
  app.use(
    express.json({
      limit: "64kb",
      // Zod .strict() does not treat "__proto__" as an unknown key, so it slips
      // through validation. Zod strips it from the output today and nothing is
      // polluted, but dropping it at parse time stops that from depending on a
      // library internal.
      reviver: (key, value) => (key === "__proto__" ? undefined : value)
    })
  );

  const publicPath = path.join(__dirname, "public");
  app.get(/^\/app$/, (_request, response) => response.redirect("/app/"));
  app.use("/app", appContentSecurityPolicy, express.static(publicPath));

  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  app.use("/api/v1/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  app.get("/api-docs.json", (_request, response) => {
    response.json(swaggerSpec);
  });

  const apiIndexHandler = (_request: Request, response: Response) => {
    const endpoints: Record<string, string> = {
      health: "GET /health",
      healthV1: "GET /api/v1/health",
      readiness: "GET /health/ready",
      readinessV1: "GET /api/v1/health/ready",
      concerts: "GET /concerts",
      concertsV1: "GET /api/v1/concerts",
      reserveV1: "POST /api/v1/reserve",
      createTicketV1: "POST /api/v1/tickets",
      purchaseV1: "POST /api/v1/purchase",
      purchaseOptimisticV1: "POST /api/v1/tickets/:ticketId/purchase-optimistic",
      purchasePessimisticV1: "POST /api/v1/tickets/:ticketId/purchase-pessimistic",
      app: "GET /app",
      firebaseConfig: "GET /api/v1/firebase-config",
      myTickets: "GET /api/v1/me/tickets",
      fcmTokens: "POST /api/v1/me/fcm-tokens",
      fcmTokenDelete: "DELETE /api/v1/me/fcm-tokens",
      docs: "GET /api-docs",
      docsV1: "GET /api/v1/docs"
    };

    if (enableLegacyDemoRoutes) {
      Object.assign(endpoints, {
        tickets: "GET /tickets",
        ticketsV1: "GET /api/v1/tickets",
        reserve: "POST /reserve",
        createTicket: "POST /tickets",
        purchase: "POST /purchase",
        purchaseOptimistic: "POST /tickets/:ticketId/purchase-optimistic",
        purchasePessimistic: "POST /tickets/:ticketId/purchase-pessimistic"
      });
    }

    if (enablePublicCleanup) {
      Object.assign(endpoints, {
        cleanup: "POST /cleanup",
        cleanupV1: "POST /api/v1/cleanup"
      });
    }

    response.json({
      name: "High-Demand Ticket Reservation Backend",
      status: "ok",
      endpoints
    });
  };

  app.get("/", apiIndexHandler);
  app.get("/api/v1", apiIndexHandler);

  /** Liveness: the process is up. Deliberately does no I/O. */
  const healthHandler = (_request: Request, response: Response) => {
    response.json({ status: "ok" });
  };

  app.get("/health", healthHandler);
  app.get("/api/v1/health", healthHandler);

  /**
   * Readiness: the process can actually serve traffic. A liveness probe that
   * always returns ok lets a release with an unusable database pass its own
   * smoke test.
   */
  const readinessHandler = asyncHandler(async (_request, response) => {
    const checks: Record<string, "ok" | "unavailable" | "not_configured"> = {
      database: "ok",
      redis: options.redisClient ? "ok" : "not_configured"
    };

    try {
      await dataSource.query("SELECT 1");
    } catch (error) {
      logger.error({ error }, "Readiness probe: database check failed");
      checks.database = "unavailable";
    }

    if (options.redisClient) {
      try {
        await options.redisClient.ping();
      } catch (error) {
        logger.error({ error }, "Readiness probe: Redis check failed");
        checks.redis = "unavailable";
      }
    }

    const ready = !Object.values(checks).includes("unavailable");
    response.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "unavailable",
      checks
    });
  });

  app.get("/health/ready", readinessHandler);
  app.get("/api/v1/health/ready", readinessHandler);

  app.get("/api/v1/firebase-config", (_request, response) => {
    response.json(getPublicFirebaseConfig());
  });

  const concertsHandler = asyncHandler(async (_request, response) => {
    const concerts = await dataSource.getRepository(Concert).find({
      order: { id: "ASC" }
    });

    response.json(concerts);
  });

  app.get("/concerts", globalRateLimiter, concertsHandler);
  app.get("/api/v1/concerts", globalRateLimiter, concertsHandler);

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

  if (enableLegacyDemoRoutes) {
    app.get("/tickets", globalRateLimiter, ticketsHandler);
    app.get("/api/v1/tickets", globalRateLimiter, ticketsHandler);
  }

  const reserveHandler = asyncHandler(async (request, response) => {
    const ticket = await reservationService.reserveTickets(request.body);
    response.status(201).json({ ticket: toTicketDto(ticket) });
  });

  const authenticatedReserveHandler = asyncHandler(async (request, response) => {
    const authRequest = request as AuthenticatedRequest;
    const ticket = await reservationService.reserveTickets({
      ...request.body,
      userId: authRequest.authUser.uid
    });
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
  if (enableLegacyDemoRoutes) {
    app.post(
      "/reserve",
      reservationRateLimiter,
      validateBody(reserveTicketSchema),
      reserveHandler
    );
  }
  // Rate limiter ahead of auth: otherwise a flood of invalid tokens is rejected
  // by the auth layer before the limiter ever runs, and each one costs a
  // Firebase token verification.
  app.post(
    "/api/v1/reserve",
    globalRateLimiter,
    firebaseAuth,
    reservationRateLimiter,
    validateBody(authenticatedReserveTicketSchema),
    authenticatedReserveHandler
  );

  if (enableLegacyDemoRoutes) {
    app.post(
      "/tickets",
      reservationRateLimiter,
      validateBody(reserveTicketSchema),
      reserveHandler
    );
  }
  app.post(
    "/api/v1/tickets",
    globalRateLimiter,
    firebaseAuth,
    reservationRateLimiter,
    validateBody(authenticatedReserveTicketSchema),
    authenticatedReserveHandler
  );

  const purchaseHandler = asyncHandler(async (request, response) => {
    const ticket = await purchaseService.purchaseTicket(request.body);
    response.json({ ticket: toTicketDto(ticket) });
  });

  if (enableLegacyDemoRoutes) {
    app.post("/purchase", validateBody(purchaseTicketSchema), purchaseHandler);
  }
  app.post(
    "/api/v1/purchase",
    globalRateLimiter,
    firebaseAuth,
    purchaseRateLimiter,
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
  if (enableLegacyDemoRoutes) {
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
  }
  app.post(
    "/api/v1/tickets/:ticketId/purchase-optimistic",
    globalRateLimiter,
    firebaseAuth,
    purchaseRateLimiter,
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
  if (enableLegacyDemoRoutes) {
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
  }
  app.post(
    "/api/v1/tickets/:ticketId/purchase-pessimistic",
    globalRateLimiter,
    firebaseAuth,
    purchaseRateLimiter,
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
    globalRateLimiter,
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
    globalRateLimiter,
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

  app.delete(
    "/api/v1/me/fcm-tokens",
    globalRateLimiter,
    firebaseAuth,
    validateBody(fcmTokenSchema),
    asyncHandler(async (request, response) => {
      const authRequest = request as AuthenticatedRequest;
      await notificationService.unregisterFcmToken(
        authRequest.authUser.uid,
        request.body.token
      );

      response.status(204).send();
    })
  );

  app.post(
    "/api/v1/debug/concurrency-error",
    globalRateLimiter,
    asyncHandler(async (request) => {
      const debugSecret = process.env.DEBUG_SECRET;

      if (!debugSecret) {
        throw new AppError(404, "NOT_FOUND", "Not found");
      }

      if (!secretsMatch(request.header("X-Debug-Secret"), debugSecret)) {
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

  if (enablePublicCleanup) {
    app.post("/cleanup", cleanupHandler);
    app.post("/api/v1/cleanup", cleanupHandler);
  }

  app.use(errorMiddleware);

  return app;
}
