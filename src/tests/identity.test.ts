import request from "supertest";
import { FcmToken } from "../entities/FcmToken";
import { MAX_FCM_TOKENS_PER_USER } from "../services/notification.service";
import type { TestHarness } from "./helpers/test-harness";
import { createTestHarness } from "./helpers/test-harness";

describe("Authentication and per-user resources", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness();
  });

  afterEach(async () => {
    await harness.destroy();
  });

  it("rejects authenticated reservation when the Firebase token is missing", async () => {
    const concert = await harness.createConcert(1);

    const response = await request(harness.app)
      .post("/api/v1/reserve")
      .send({ concertId: concert.id, category: "General", quantity: 1 })
      .expect(401);

    expect(response.body.error).toBe("UNAUTHORIZED");
  });

  it("rejects authenticated reservation when the authorization header is malformed", async () => {
    const concert = await harness.createConcert(1);

    const response = await request(harness.app)
      .post("/api/v1/reserve")
      .set("Authorization", "Token owner_token")
      .send({ concertId: concert.id, category: "General", quantity: 1 })
      .expect(401);

    expect(response.body.error).toBe("UNAUTHORIZED");
  });

  it("rejects authenticated reservation when Firebase rejects the token", async () => {
    const concert = await harness.createConcert(1);

    const response = await harness
      .authenticatedRequest("bad_token")
      .send({ concertId: concert.id, category: "General", quantity: 1 })
      .expect(401);

    expect(response.body.error).toBe("UNAUTHORIZED");
  });

  it("reports 503 when Firebase auth is not configured at all", async () => {
    const unconfiguredApp = harness.buildApp({
      firebaseAuthVerifier: undefined
    });

    const response = await request(unconfiguredApp)
      .get("/api/v1/me/tickets")
      .set("Authorization", "Bearer owner_token")
      .expect(503);

    expect(response.body.error).toBe("FIREBASE_NOT_CONFIGURED");
  });

  it("returns only the signed-in user's tickets", async () => {
    const concert = await harness.createConcert(2);
    await harness
      .authenticatedRequest()
      .send({ concertId: concert.id, category: "General", quantity: 1 })
      .expect(201);
    await harness
      .authenticatedRequest("other_token")
      .send({ concertId: concert.id, category: "General", quantity: 1 })
      .expect(201);

    const response = await request(harness.app)
      .get("/api/v1/me/tickets")
      .set("Authorization", "Bearer owner_token")
      .expect(200);

    expect(response.body).toEqual([
      expect.objectContaining({ userId: "firebase_owner" })
    ]);
  });

  it("serves the signed-in ticket list through an index rather than a scan", async () => {
    const plan = await harness.dataSource.query(
      `EXPLAIN QUERY PLAN SELECT * FROM tickets WHERE "userId" = ? ORDER BY id ASC`,
      ["firebase_owner"]
    );

    expect(plan.map((row: { detail: string }) => row.detail).join(" ")).toContain(
      "idx_tickets_user_id"
    );
  });

  it("upserts FCM tokens for the signed-in user", async () => {
    const token = "fcm-token-value-with-enough-length";

    await request(harness.app)
      .post("/api/v1/me/fcm-tokens")
      .set("Authorization", "Bearer owner_token")
      .send({ token })
      .expect(201);
    await request(harness.app)
      .post("/api/v1/me/fcm-tokens")
      .set("Authorization", "Bearer other_token")
      .send({ token })
      .expect(201);

    const tokens = await harness.dataSource.getRepository(FcmToken).find();

    expect(tokens).toEqual([
      expect.objectContaining({ token, userId: "firebase_other" })
    ]);
  });

  it("deletes only the signed-in user's FCM token", async () => {
    const token = "fcm-token-value-with-enough-length";

    await request(harness.app)
      .post("/api/v1/me/fcm-tokens")
      .set("Authorization", "Bearer owner_token")
      .send({ token })
      .expect(201);

    await request(harness.app)
      .delete("/api/v1/me/fcm-tokens")
      .set("Authorization", "Bearer other_token")
      .send({ token })
      .expect(204);

    expect(await harness.dataSource.getRepository(FcmToken).count()).toBe(1);

    await request(harness.app)
      .delete("/api/v1/me/fcm-tokens")
      .set("Authorization", "Bearer owner_token")
      .send({ token })
      .expect(204);

    expect(await harness.dataSource.getRepository(FcmToken).count()).toBe(0);
  });

  it("caps stored FCM tokens per user and evicts the oldest", async () => {
    for (let index = 0; index < MAX_FCM_TOKENS_PER_USER + 3; index += 1) {
      await request(harness.app)
        .post("/api/v1/me/fcm-tokens")
        .set("Authorization", "Bearer owner_token")
        .send({ token: `fcm-token-value-with-enough-length-${index}` })
        .expect(201);
    }

    const tokens = await harness.dataSource
      .getRepository(FcmToken)
      .find({ where: { userId: "firebase_owner" }, order: { id: "ASC" } });

    expect(tokens).toHaveLength(MAX_FCM_TOKENS_PER_USER);
    expect(tokens[0].token).toBe("fcm-token-value-with-enough-length-3");
  });

  it("enforces the cap when a token is reassigned to another user", async () => {
    for (let index = 0; index < MAX_FCM_TOKENS_PER_USER; index += 1) {
      await request(harness.app)
        .post("/api/v1/me/fcm-tokens")
        .set("Authorization", "Bearer other_token")
        .send({ token: `other-token-with-enough-length-${index}` })
        .expect(201);
    }

    await request(harness.app)
      .post("/api/v1/me/fcm-tokens")
      .set("Authorization", "Bearer owner_token")
      .send({ token: "shared-device-token-with-enough-length" })
      .expect(201);
    await request(harness.app)
      .post("/api/v1/me/fcm-tokens")
      .set("Authorization", "Bearer other_token")
      .send({ token: "shared-device-token-with-enough-length" })
      .expect(201);

    const tokens = await harness.dataSource
      .getRepository(FcmToken)
      .find({ where: { userId: "firebase_other" } });

    expect(tokens).toHaveLength(MAX_FCM_TOKENS_PER_USER);
    expect(tokens.map((token) => token.token)).toContain(
      "shared-device-token-with-enough-length"
    );
  });
});
