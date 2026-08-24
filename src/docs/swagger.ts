import path from "node:path";
import swaggerJSDoc from "swagger-jsdoc";

/** Resolved against this module so it works from dist as well as src. */
const annotatedSources = [
  path.join(__dirname, "..", "app.ts"),
  path.join(__dirname, "..", "app.js")
];

export const swaggerSpec = swaggerJSDoc({
  definition: {
    openapi: "3.0.0",
    info: {
      title: "High-Demand Ticket Reservation Backend",
      version: "3.0.0",
      description:
        "Hardened ticket API with validation, logging, locking, and rate limiting."
    },
    servers: [
      {
        url: "/api/v1",
        description: "Production API base path"
      },
      {
        url: "/",
        description: "Local development base path"
      }
    ],
    components: {
      securitySchemes: {
        FirebaseBearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "Firebase ID token"
        }
      },
      schemas: {
        ReserveRequest: {
          type: "object",
          required: ["concertId", "userId", "quantity"],
          additionalProperties: false,
          properties: {
            concertId: { type: "integer", example: 1 },
            userId: { type: "string", example: "user_123" },
            category: { type: "string", example: "General" },
            quantity: { type: "integer", minimum: 1, maximum: 5, example: 1 }
          }
        },
        AuthenticatedReserveRequest: {
          type: "object",
          required: ["concertId", "quantity"],
          additionalProperties: false,
          properties: {
            concertId: { type: "integer", example: 1 },
            category: { type: "string", example: "General" },
            quantity: { type: "integer", minimum: 1, maximum: 5, example: 1 }
          }
        },
        AuthenticatedPurchaseRequest: {
          type: "object",
          required: ["ticketId"],
          additionalProperties: false,
          properties: {
            ticketId: { type: "integer", example: 1 }
          }
        },
        FcmTokenRequest: {
          type: "object",
          required: ["token"],
          additionalProperties: false,
          properties: {
            token: { type: "string", example: "fcm-registration-token" }
          }
        },
        FirebaseConfig: {
          type: "object",
          properties: {
            apiKey: { type: "string" },
            authDomain: { type: "string" },
            projectId: { type: "string" },
            messagingSenderId: { type: "string" },
            appId: { type: "string" },
            vapidKey: { type: "string" }
          }
        },
        PurchaseRequest: {
          type: "object",
          required: ["userId"],
          additionalProperties: false,
          properties: {
            userId: { type: "string", example: "user_123" }
          }
        },
        LegacyPurchaseRequest: {
          type: "object",
          required: ["ticketId", "userId"],
          additionalProperties: false,
          properties: {
            ticketId: { type: "integer", example: 1 },
            userId: { type: "string", example: "user_123" }
          }
        },
        TicketDto: {
          type: "object",
          properties: {
            id: { type: "integer", example: 1 },
            concertId: { type: "integer", example: 1 },
            userId: { type: "string", example: "user_123" },
            status: { type: "string", example: "PENDING" },
            category: { type: "string", example: "General" },
            quantity: { type: "integer", example: 1 },
            expiresAt: { type: "string", nullable: true },
            createdAt: { type: "string" }
          }
        },
        ErrorResponse: {
          type: "object",
          properties: {
            error: { type: "string", example: "LOCK_CONFLICT" },
            message: { type: "string", example: "User friendly message" },
            ref: { type: "string", example: "correlation-id" }
          }
        }
      }
    }
  },
  apis: annotatedSources
});
