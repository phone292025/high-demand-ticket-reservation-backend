import express from "express";
import request from "supertest";
import {
  EntityNotFoundError,
  OptimisticLockVersionMismatchError,
  QueryFailedError
} from "typeorm";
import type { Messaging } from "firebase-admin/messaging";
import { Ticket } from "../entities/Ticket";
import { AppError } from "../errors/AppError";
import { correlationIdMiddleware } from "../middleware/correlation-id.middleware";
import { errorMiddleware } from "../middleware/error.middleware";
import { FirebaseNotificationSender } from "../services/notification.service";

/** Minimal app that throws whatever a test hands it, then maps the error. */
function appThrowing(error: unknown) {
  const app = express();
  app.use(correlationIdMiddleware);
  app.get("/boom", () => {
    throw error;
  });
  app.use(errorMiddleware);
  return app;
}

describe("Error mapping", () => {
  it("maps an optimistic lock mismatch to 409 rather than 500", async () => {
    const response = await request(
      appThrowing(new OptimisticLockVersionMismatchError("Ticket", 1, 2))
    )
      .get("/boom")
      .expect(409);

    expect(response.body.error).toBe("LOCK_CONFLICT");
  });

  it("maps SQLITE_BUSY write contention to 409", async () => {
    const busyError = new QueryFailedError("UPDATE tickets", [], {
      code: "SQLITE_BUSY",
      message: "database is locked"
    } as unknown as Error);

    const response = await request(appThrowing(busyError)).get("/boom").expect(409);

    expect(response.body.error).toBe("LOCK_CONFLICT");
    expect(response.body.message).toContain("retry");
  });

  it("still reports an unrelated query failure as 500", async () => {
    const syntaxError = new QueryFailedError("SELECT nope", [], {
      code: "SQLITE_ERROR",
      message: "no such column"
    } as unknown as Error);

    const response = await request(appThrowing(syntaxError))
      .get("/boom")
      .expect(500);

    expect(response.body.error).toBe("INTERNAL_ERROR");
    // The driver message must not leak to the client.
    expect(response.body.message).toBe("Internal server error");
  });

  it("maps a missing entity to 404", async () => {
    const response = await request(
      appThrowing(new EntityNotFoundError(Ticket, { id: 1 }))
    )
      .get("/boom")
      .expect(404);

    expect(response.body.error).toBe("NOT_FOUND");
  });

  it("passes an explicit AppError through untouched", async () => {
    const response = await request(
      appThrowing(new AppError(418, "TEAPOT", "Short and stout"))
    )
      .get("/boom")
      .expect(418);

    expect(response.body).toMatchObject({
      error: "TEAPOT",
      message: "Short and stout"
    });
    expect(response.body.ref).toBeDefined();
  });
});

describe("FirebaseNotificationSender", () => {
  function senderWith(response: unknown) {
    const sendEachForMulticast = jest.fn().mockResolvedValue(response);
    const messaging = { sendEachForMulticast } as unknown as Messaging;
    return {
      sender: new FirebaseNotificationSender(messaging),
      sendEachForMulticast
    };
  }

  const payload = {
    title: "Reservation expiring soon",
    body: "Almost out of time."
  };

  it("does not call FCM for an empty token list", async () => {
    const { sender, sendEachForMulticast } = senderWith({});

    await expect(sender.sendToTokens([], payload)).resolves.toEqual({
      successCount: 0,
      failureCount: 0,
      invalidTokens: []
    });
    expect(sendEachForMulticast).not.toHaveBeenCalled();
  });

  it("reports per-token failures instead of assuming the batch succeeded", async () => {
    const { sender } = senderWith({
      successCount: 1,
      failureCount: 2,
      responses: [
        { success: true },
        {
          success: false,
          error: { code: "messaging/registration-token-not-registered" }
        },
        { success: false, error: { code: "messaging/internal-error" } }
      ]
    });

    const result = await sender.sendToTokens(
      ["good-token", "dead-token", "flaky-token"],
      payload
    );

    expect(result.successCount).toBe(1);
    expect(result.failureCount).toBe(2);
    // Only the permanently invalid one is offered up for deletion; a transient
    // internal error must not cost the user their registration.
    expect(result.invalidTokens).toEqual(["dead-token"]);
  });

  it("treats an invalid registration token as permanently dead", async () => {
    const { sender } = senderWith({
      successCount: 0,
      failureCount: 1,
      responses: [
        { success: false, error: { code: "messaging/invalid-registration-token" } }
      ]
    });

    const result = await sender.sendToTokens(["malformed-token"], payload);

    expect(result.invalidTokens).toEqual(["malformed-token"]);
  });
});

describe("Body parser errors", () => {
  function appWithLimit(limit: string) {
    const app = express();
    app.use(correlationIdMiddleware);
    app.use(express.json({ limit }));
    app.post("/echo", (_request, response) => response.json({ ok: true }));
    app.use(errorMiddleware);
    return app;
  }

  it("rejects an oversized body as 413, not 500", async () => {
    const response = await request(appWithLimit("1kb"))
      .post("/echo")
      .set("Content-Type", "application/json")
      .send({ padding: "x".repeat(5000) })
      .expect(413);

    expect(response.body.error).toBe("PAYLOAD_TOO_LARGE");
    expect(response.body.ref).toBeDefined();
  });

  it("still accepts a body under the limit", async () => {
    await request(appWithLimit("1kb"))
      .post("/echo")
      .send({ padding: "x" })
      .expect(200);
  });
});
