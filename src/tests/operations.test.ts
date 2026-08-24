import http from "node:http";
import type { DataSource } from "typeorm";
import {
  SHUTDOWN_SIGNALS,
  registerGracefulShutdown
} from "../operations/graceful-shutdown";
import { startNotificationWorker } from "../operations/notification-worker";
import type { NotificationService } from "../services/notification.service";

function listeningServer(): Promise<http.Server> {
  const server = http.createServer((_request, response) => response.end("ok"));
  return new Promise((resolve) => {
    server.listen(0, () => resolve(server));
  });
}

describe("Graceful shutdown", () => {
  let exitSpy: jest.SpyInstance;
  let servers: http.Server[] = [];

  beforeAll(() => {
    exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
  });

  afterAll(() => {
    exitSpy.mockRestore();
  });

  beforeEach(() => {
    exitSpy.mockClear();
  });

  afterEach(async () => {
    for (const signal of SHUTDOWN_SIGNALS) {
      process.removeAllListeners(signal);
    }

    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          })
      )
    );
    servers = [];
  });

  async function runShutdown(signal: NodeJS.Signals = "SIGTERM") {
    const server = await listeningServer();
    servers.push(server);

    const order: string[] = [];
    const dataSource = {
      isInitialized: true,
      destroy: jest.fn(async () => {
        order.push("database");
      })
    } as unknown as DataSource;

    registerGracefulShutdown({
      server,
      dataSource,
      waitMs: 0,
      onShutdown: [
        () => {
          order.push("worker-a");
        },
        async () => {
          order.push("worker-b");
        }
      ]
    });

    process.emit(signal);
    // Let the async shutdown chain settle.
    await new Promise((resolve) => setTimeout(resolve, 60));

    return { order, dataSource, server };
  }

  it("stops background workers before destroying the database", async () => {
    const { order, dataSource } = await runShutdown();

    expect(order).toEqual(["worker-a", "worker-b", "database"]);
    expect(dataSource.destroy).toHaveBeenCalledTimes(1);
  });

  it("handles SIGINT as well as SIGTERM", async () => {
    const { order } = await runShutdown("SIGINT");

    expect(order).toContain("database");
  });

  it("ignores a second signal once shutdown is under way", async () => {
    const server = await listeningServer();
    servers.push(server);

    const destroy = jest.fn(async () => undefined);
    const dataSource = { isInitialized: true, destroy } as unknown as DataSource;

    registerGracefulShutdown({ server, dataSource, waitMs: 0 });

    process.emit("SIGTERM");
    process.emit("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("forces an exit when the shutdown sequence overruns its budget", async () => {
    const server = await listeningServer();
    servers.push(server);

    const dataSource = {
      isInitialized: true,
      destroy: jest.fn(async () => undefined)
    } as unknown as DataSource;

    registerGracefulShutdown({
      server,
      dataSource,
      waitMs: 0,
      forceExitMs: 30,
      // Never settles, so only the force-exit timer can end this. A pending
      // promise rather than a long timer, so it cannot outlive the test run.
      onShutdown: [() => new Promise<void>(() => undefined)]
    });

    process.emit("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("Notification worker", () => {
  it("polls for due notifications and stops cleanly", async () => {
    const processDueExpirationWarnings = jest
      .fn()
      .mockResolvedValue({ sentCount: 1, skippedCount: 0, failedCount: 0 });
    const notificationService = {
      processDueExpirationWarnings
    } as unknown as NotificationService;

    const worker = startNotificationWorker(notificationService, 10);
    await new Promise((resolve) => setTimeout(resolve, 60));
    worker.stop();

    const callsWhileRunning = processDueExpirationWarnings.mock.calls.length;
    expect(callsWhileRunning).toBeGreaterThan(0);

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(processDueExpirationWarnings.mock.calls.length).toBe(callsWhileRunning);
  });

  it("keeps running after a failed tick", async () => {
    const processDueExpirationWarnings = jest
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ sentCount: 0, skippedCount: 0, failedCount: 0 });
    const notificationService = {
      processDueExpirationWarnings
    } as unknown as NotificationService;

    const worker = startNotificationWorker(notificationService, 10);
    await new Promise((resolve) => setTimeout(resolve, 60));
    worker.stop();

    expect(processDueExpirationWarnings.mock.calls.length).toBeGreaterThan(1);
  });
});
