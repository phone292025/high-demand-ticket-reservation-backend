import express, {
  ErrorRequestHandler,
  NextFunction,
  Request,
  Response
} from "express";
import { DataSource } from "typeorm";
import { Concert } from "./entities/Concert";
import { AppError } from "./errors/AppError";
import { CleanupService } from "./services/cleanup.service";
import { PurchaseService } from "./services/purchase.service";
import { ReservationService } from "./services/reservation.service";

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

export function createApp(dataSource: DataSource) {
  const app = express();
  const reservationService = new ReservationService(dataSource);
  const purchaseService = new PurchaseService(dataSource);
  const cleanupService = new CleanupService(dataSource);

  app.use(express.json());

  app.get("/", (_request, response) => {
    response.json({
      name: "High-Demand Ticket Reservation Backend",
      status: "ok",
      endpoints: {
        health: "GET /health",
        concerts: "GET /concerts",
        reserve: "POST /reserve",
        purchase: "POST /purchase",
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

  app.post(
    "/reserve",
    asyncHandler(async (request, response) => {
      const ticket = await reservationService.reserveTicket(request.body);
      response.status(201).json({ ticket });
    })
  );

  app.post(
    "/purchase",
    asyncHandler(async (request, response) => {
      const ticket = await purchaseService.purchaseTicket(request.body);
      response.json({ ticket });
    })
  );

  app.post(
    "/cleanup",
    asyncHandler(async (_request, response) => {
      const cleanupResult = await cleanupService.cleanupExpiredReservations();
      response.json(cleanupResult);
    })
  );

  const errorHandler: ErrorRequestHandler = (
    error,
    _request,
    response,
    _next
  ) => {
    if (error instanceof SyntaxError && "body" in error) {
      response.status(400).json({ error: "Invalid JSON body" });
      return;
    }

    if (error instanceof AppError) {
      response.status(error.statusCode).json({ error: error.message });
      return;
    }

    console.error(error);
    response.status(500).json({ error: "Internal server error" });
  };

  app.use(errorHandler);

  return app;
}
