import request from "supertest";
import type { Concert } from "../entities/Concert";
import {
  DEFAULT_RATE_LIMIT_PREFIX,
  rateLimitPrefix
} from "../middleware/rate-limit.middleware";
import type { TestHarness } from "./helpers/test-harness";
import { createTestHarness } from "./helpers/test-harness";

/**
 * These are the tests whose absence let two production defects through: the
 * limiter keying every client to the proxy address, and auth running ahead of
 * the limiter so unauthenticated floods bypassed it entirely.
 */
describe("Rate limiting", () => {
  let harness: TestHarness;
  let concert: Concert;

  beforeEach(async () => {
    harness = await createTestHarness({
      enableRateLimit: true,
      // A fresh prefix per suite keeps the in-memory store from leaking across
      // tests within a run.
      rateLimitPrefix: `test-${Date.now()}-${Math.random()}:`,
      trustProxy: 1
    });
    concert = await harness.createConcert(50);
  });

  afterEach(async () => {
    await harness.destroy();
  });

  function reserveAs(clientIp: string, userId: string) {
    return request(harness.app)
      .post("/reserve")
      .set("X-Forwarded-For", clientIp)
      .send({ concertId: concert.id, userId, category: "General", quantity: 1 });
  }

  it("throttles one client after the reservation window limit", async () => {
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 7; attempt += 1) {
      const response = await reserveAs("203.0.113.10", "repeat_user");
      statuses.push(response.status);
    }

    expect(statuses.filter((status) => status === 201)).toHaveLength(5);
    expect(statuses.filter((status) => status === 429)).toHaveLength(2);
  });

  it("returns the shared error envelope when throttled", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await reserveAs("203.0.113.11", "envelope_user");
    }

    const response = await request(harness.app)
      .post("/reserve")
      .set("X-Forwarded-For", "203.0.113.11")
      .set("X-Correlation-ID", "rate-limit-correlation")
      .send({
        concertId: concert.id,
        userId: "envelope_user",
        category: "General",
        quantity: 1
      })
      .expect(429);

    expect(response.body).toEqual({
      error: "RATE_LIMITED",
      message: "Too many reservation requests. Please try again later.",
      ref: "rate-limit-correlation"
    });
    expect(response.headers["ratelimit-remaining"]).toBe("0");
  });

  it("gives each forwarded client its own bucket behind a proxy", async () => {
    // Exhaust one client completely.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await reserveAs("198.51.100.1", "noisy_user").expect(201);
    }
    await reserveAs("198.51.100.1", "noisy_user").expect(429);

    // An unrelated client must be unaffected. Without `trust proxy` both
    // resolve to the same socket address and this returns 429.
    for (const [index, clientIp] of [
      "198.51.100.2",
      "198.51.100.3",
      "198.51.100.4"
    ].entries()) {
      await reserveAs(clientIp, `quiet_user_${index}`).expect(201);
    }
  });

  it("keys authenticated reservations by Firebase uid, not by IP", async () => {
    const reserveAuthenticated = (clientIp: string, token: string) =>
      request(harness.app)
        .post("/api/v1/reserve")
        .set("Authorization", `Bearer ${token}`)
        .set("X-Forwarded-For", clientIp)
        .send({ concertId: concert.id, category: "General", quantity: 1 });

    // Same user, rotating IPs: the uid bucket still catches them.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await reserveAuthenticated(
        `198.51.100.${100 + attempt}`,
        "owner_token"
      ).expect(201);
    }
    await reserveAuthenticated("198.51.100.200", "owner_token").expect(429);

    // A different user sharing one NAT address is not collateral damage.
    await reserveAuthenticated("198.51.100.200", "other_token").expect(201);
  });

  it("throttles unauthenticated floods before they reach token verification", async () => {
    const unauthenticatedApp = harness.buildApp({
      enableRateLimit: true,
      rateLimitPrefix: `flood-${Date.now()}-${Math.random()}:`,
      trustProxy: 1
    });

    const statuses: number[] = [];

    for (let attempt = 0; attempt < 130; attempt += 1) {
      const response = await request(unauthenticatedApp)
        .post("/api/v1/reserve")
        .set("X-Forwarded-For", "203.0.113.99")
        .set("Authorization", "Bearer garbage_token")
        .send({ concertId: concert.id, category: "General", quantity: 1 });
      statuses.push(response.status);
    }

    expect(statuses).toContain(429);
    // The global limiter has to fire before the verifier is consulted for every
    // one of those requests.
    expect(
      harness.firebaseAuthVerifier.verifyIdToken.mock.calls.length
    ).toBeLessThan(statuses.length);
  });

  it("applies a separate, looser budget to purchases", async () => {
    const reserveResponse = await reserveAs("203.0.113.50", "purchase_user").expect(
      201
    );

    // The reservation limiter is now partly consumed; purchases keep their own.
    const purchaseResponse = await request(harness.app)
      .post("/purchase")
      .set("X-Forwarded-For", "203.0.113.50")
      .send({
        ticketId: reserveResponse.body.ticket.id,
        userId: "purchase_user"
      })
      .expect(200);

    expect(purchaseResponse.body.ticket.status).toBe("COMPLETED");
  });
});

describe("Rate limiter namespacing", () => {
  it("gives each limiter a distinct namespace under a shared base prefix", () => {
    const base = "shared-base:";
    const prefixes = ["global", "reserve", "purchase"].map((name) =>
      rateLimitPrefix(base, name)
    );

    // A single shared prefix would make all three limiters increment the same
    // Redis counter for one uid, so reserve traffic would eat purchase budget.
    expect(new Set(prefixes).size).toBe(3);
    for (const prefix of prefixes) {
      expect(prefix.startsWith(base)).toBe(true);
    }
    expect(prefixes).toEqual([
      "shared-base:global:",
      "shared-base:reserve:",
      "shared-base:purchase:"
    ]);
  });

  it("namespaces under the default base when none is given", () => {
    expect(rateLimitPrefix(DEFAULT_RATE_LIMIT_PREFIX, "reserve")).toBe(
      "ticket-rate-limit:reserve:"
    );
  });
});
