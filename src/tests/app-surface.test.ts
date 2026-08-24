import request from "supertest";
import type { Concert } from "../entities/Concert";
import type { TestHarness } from "./helpers/test-harness";
import { createTestHarness } from "./helpers/test-harness";

describe("Application surface", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness();
  });

  afterEach(async () => {
    await harness.destroy();
  });

  it("returns health status with a generated correlation id", async () => {
    const response = await request(harness.app).get("/health").expect(200);

    expect(response.body).toEqual({ status: "ok" });
    expect(response.headers["x-correlation-id"]).toBeDefined();
  });

  it("preserves a provided correlation id", async () => {
    const response = await request(harness.app)
      .get("/health")
      .set("X-Correlation-ID", "test-correlation")
      .expect(200);

    expect(response.headers["x-correlation-id"]).toBe("test-correlation");
  });

  it("reports readiness only when the database answers", async () => {
    const response = await request(harness.app).get("/health/ready").expect(200);

    expect(response.body).toEqual({
      status: "ready",
      checks: { database: "ok", redis: "not_configured" }
    });

    await harness.dataSource.destroy();

    const unavailable = await request(harness.app)
      .get("/api/v1/health/ready")
      .expect(503);

    expect(unavailable.body.status).toBe("unavailable");
    expect(unavailable.body.checks.database).toBe("unavailable");
  });

  it("sends hardening headers and hides the server stack", async () => {
    const response = await request(harness.app).get("/health").expect(200);

    expect(response.headers["x-powered-by"]).toBeUndefined();
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(response.headers["strict-transport-security"]).toBeDefined();
    expect(response.headers["cross-origin-opener-policy"]).toBe(
      "same-origin-allow-popups"
    );
  });

  it("applies a Firebase-aware content security policy to the PWA only", async () => {
    const appResponse = await request(harness.app)
      .get("/app/index.html")
      .expect(200);
    const policy = appResponse.headers["content-security-policy"];

    expect(policy).toContain("script-src 'self' https://www.gstatic.com");
    expect(policy).toContain("frame-ancestors 'none'");

    // Swagger UI ships inline scripts and must stay outside that policy.
    const docsResponse = await request(harness.app).get("/docs/").expect(200);
    expect(docsResponse.headers["content-security-policy"]).toBeUndefined();
  });

  it("returns API information from the root route", async () => {
    const response = await request(harness.app).get("/").expect(200);

    expect(response.body.endpoints).toMatchObject({
      health: "GET /health",
      readiness: "GET /health/ready",
      concerts: "GET /concerts",
      tickets: "GET /tickets",
      reserve: "POST /reserve",
      createTicket: "POST /tickets",
      purchase: "POST /purchase",
      purchaseOptimistic: "POST /tickets/:ticketId/purchase-optimistic",
      purchasePessimistic: "POST /tickets/:ticketId/purchase-pessimistic",
      cleanup: "POST /cleanup"
    });
  });

  it("returns API information from the production /api/v1 route", async () => {
    const response = await request(harness.app).get("/api/v1").expect(200);

    expect(response.body.endpoints).toMatchObject({
      healthV1: "GET /api/v1/health",
      concertsV1: "GET /api/v1/concerts",
      ticketsV1: "GET /api/v1/tickets",
      reserveV1: "POST /api/v1/reserve",
      purchaseV1: "POST /api/v1/purchase",
      cleanupV1: "POST /api/v1/cleanup",
      myTickets: "GET /api/v1/me/tickets",
      fcmTokens: "POST /api/v1/me/fcm-tokens"
    });
  });

  it("does not expose legacy demo or public cleanup routes unless enabled", async () => {
    const secureDefaultApp = harness.buildApp();

    const indexResponse = await request(secureDefaultApp).get("/").expect(200);
    expect(indexResponse.body.endpoints).not.toHaveProperty("tickets");
    expect(indexResponse.body.endpoints).not.toHaveProperty("reserve");
    expect(indexResponse.body.endpoints).not.toHaveProperty("purchase");
    expect(indexResponse.body.endpoints).not.toHaveProperty("cleanup");

    await request(secureDefaultApp).get("/api/v1/tickets").expect(404);
    await request(secureDefaultApp)
      .post("/reserve")
      .send({ concertId: 1, userId: "attacker", category: "General", quantity: 1 })
      .expect(404);
    await request(secureDefaultApp)
      .post("/purchase")
      .send({ ticketId: 1, userId: "attacker" })
      .expect(404);
    await request(secureDefaultApp).post("/api/v1/cleanup").expect(404);
  });

  it("serves health and Swagger through production aliases", async () => {
    await request(harness.app).get("/api/v1/health").expect(200);
    await request(harness.app).get("/docs/").expect(200);
    await request(harness.app).get("/api/v1/docs/").expect(200);
  });

  it("serves the Offline PWA shell and manifest", async () => {
    await request(harness.app).get("/app/index.html").expect(200);
    await request(harness.app).get("/app/manifest.webmanifest").expect(200);
    await request(harness.app).get("/app/sw.js").expect(200);
  });

  it("maps malformed JSON through the global error middleware", async () => {
    const response = await request(harness.app)
      .post("/reserve")
      .set("Content-Type", "application/json")
      .set("X-Correlation-ID", "bad-json-correlation")
      .send("{bad json")
      .expect(400);

    expect(response.body).toEqual({
      error: "VALIDATION_ERROR",
      message: "Invalid JSON body",
      ref: "bad-json-correlation"
    });
  });

  it("rejects unknown request fields with Zod strict validation", async () => {
    const response = await request(harness.app)
      .post("/reserve")
      .set("X-Correlation-ID", "strict-validation")
      .send({
        concertId: 1,
        userId: "user_123",
        category: "General",
        quantity: 1,
        unexpected: "nope"
      })
      .expect(400);

    expect(response.body).toEqual({
      error: "VALIDATION_ERROR",
      message: "Invalid request body",
      ref: "strict-validation"
    });
  });

  it("protects the ConcurrencyError debug endpoint", async () => {
    const previousDebugSecret = process.env.DEBUG_SECRET;

    try {
      delete process.env.DEBUG_SECRET;
      await request(harness.app)
        .post("/api/v1/debug/concurrency-error")
        .set("X-Debug-Secret", "secret")
        .expect(404);

      process.env.DEBUG_SECRET = "debug-secret";
      await request(harness.app)
        .post("/api/v1/debug/concurrency-error")
        .set("X-Debug-Secret", "wrong-secret")
        .expect(403);

      // Constant-time comparison must still reject a length mismatch.
      await request(harness.app)
        .post("/api/v1/debug/concurrency-error")
        .set("X-Debug-Secret", "debug-secret-but-longer")
        .expect(403);

      const response = await request(harness.app)
        .post("/api/v1/debug/concurrency-error")
        .set("X-Debug-Secret", "debug-secret")
        .expect(409);

      expect(response.body.error).toBe("LOCK_CONFLICT");
      expect(response.body.message).toBe(
        "Manual ConcurrencyError test triggered for Sentry verification"
      );
    } finally {
      if (previousDebugSecret === undefined) {
        delete process.env.DEBUG_SECRET;
      } else {
        process.env.DEBUG_SECRET = previousDebugSecret;
      }
    }
  });

  it("returns seeded concerts", async () => {
    const response = await request(harness.app).get("/concerts").expect(200);
    const concertNames = response.body.map((concert: Concert) => concert.name);

    expect(concertNames).toEqual(
      expect.arrayContaining([
        "Rock Night 2026",
        "APU Live Concert",
        "VIP Acoustic Show"
      ])
    );
  });

  it("exposes the hardened endpoints in the Swagger spec", async () => {
    const response = await request(harness.app).get("/api-docs.json").expect(200);

    expect(Object.keys(response.body.paths)).toEqual(
      expect.arrayContaining([
        "/reserve",
        "/tickets",
        "/tickets/{ticketId}/purchase-optimistic",
        "/tickets/{ticketId}/purchase-pessimistic"
      ])
    );
    expect(response.body.servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: "/api/v1" }),
        expect.objectContaining({ url: "/" })
      ])
    );
  });
});

describe("Request body hardening", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness();
  });

  afterEach(async () => {
    await harness.destroy();
  });

  it("drops __proto__ from a JSON body", async () => {
    const concert = await harness.createConcert(1);

    await request(harness.app)
      .post("/reserve")
      .set("Content-Type", "application/json")
      .send(
        `{"concertId":${concert.id},"userId":"pp","quantity":1,"__proto__":{"polluted":"yes"}}`
      )
      .expect(201);

    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rejects a body over the size limit with 413", async () => {
    const response = await request(harness.app)
      .post("/reserve")
      .set("Content-Type", "application/json")
      .send({ concertId: 1, userId: "x".repeat(200_000), quantity: 1 })
      .expect(413);

    expect(response.body.error).toBe("PAYLOAD_TOO_LARGE");
  });
});
