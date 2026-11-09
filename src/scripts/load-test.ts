// Fires many reservation requests at once over real HTTP and checks that no
// seat is sold twice. A deliberately naive endpoint (read stock, then write)
// runs the same load as a control, to show the test can catch overselling.
//
// Usage: npm run load:test -- --buyers=1000 --stock=100 --runs=5 --connections=150
process.env.LOG_LEVEL ??= "silent";

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import type { DataSource } from "typeorm";

type Scenario = "single" | "mixed";
type Target = "real" | "naive";

interface RunResult {
  target: Target;
  scenario: Scenario;
  buyers: number;
  stock: number;
  created: number;
  soldOut: number;
  otherStatuses: Record<string, number>;
  seatsSold: number;
  availableStock: number;
  oversold: number;
  stockAddsUp: boolean;
  wallMs: number;
  requestsPerSecond: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

function readArg(name: string, fallback: number): number {
  const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  const value = match ? Number(match.split("=")[1]) : fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

function percentile(sorted: number[], fraction: number): number {
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(fraction * sorted.length) - 1
  );
  return Math.round(sorted[Math.max(0, index)] * 10) / 10;
}

/** Same quantities every run, so results compare across runs. */
function quantityFor(scenario: Scenario, buyer: number): number {
  return scenario === "single" ? 1 : ((buyer * 7919) % 5) + 1;
}

async function main() {
  const buyers = readArg("buyers", 1000);
  const stock = readArg("stock", 100);
  const runs = readArg("runs", 3);
  const connections = readArg("connections", 150);

  const { createApp } = await import("../app");
  const { createDataSource, initializeDataSource } = await import("../data-source");
  const { Concert } = await import("../entities/Concert");
  const { Ticket } = await import("../entities/Ticket");
  const { TicketStatus } = await import("../entities/TicketStatus");
  const { reservationExpiry } = await import("../utils/date");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-load-"));
  const dataSource: DataSource = createDataSource(path.join(dir, "load.sqlite"));
  await initializeDataSource(dataSource);
  await dataSource.runMigrations();

  const app = createApp(dataSource, { enableLegacyDemoRoutes: true });

  // Control: no transaction, no conditional update, no write lock.
  app.post("/naive-reserve", async (request, response) => {
    const { concertId, userId, quantity } = request.body;
    const concert = await dataSource
      .getRepository(Concert)
      .findOneByOrFail({ id: concertId });
    if (concert.availableStock < quantity) {
      response.status(409).json({ error: "SOLD_OUT" });
      return;
    }
    await dataSource
      .getRepository(Concert)
      .update(concertId, { availableStock: concert.availableStock - quantity });
    const ticket = await dataSource.getRepository(Ticket).save(
      dataSource.getRepository(Ticket).create({
        concertId,
        userId,
        quantity,
        category: "General",
        status: TicketStatus.Pending,
        expiresAt: reservationExpiry()
      })
    );
    response.status(201).json({ ticket });
  });

  // Default backlog (511) refuses connections when every buyer connects at once.
  const server = http.createServer(app);
  await new Promise<void>((resolve) =>
    server.listen({ port: 0, host: "127.0.0.1", backlog: 4096 }, resolve)
  );
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  // Windows desktop editions cap the accept backlog near 200, so cap client
  // sockets too. All requests are still sent at once; extras queue client-side.
  const agent = new http.Agent({ keepAlive: true, maxSockets: connections });
  function postJson(url: string, body: unknown): Promise<number> {
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const request = http.request(
        url,
        {
          method: "POST",
          agent,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload)
          }
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode ?? 0));
        }
      );
      request.on("error", reject);
      request.end(payload);
    });
  }

  async function runOnce(target: Target, scenario: Scenario): Promise<RunResult> {
    const concertRepository = dataSource.getRepository(Concert);
    const concert = await concertRepository.save(
      concertRepository.create({
        name: `Load test ${target} ${scenario}`,
        venue: "Load Test Arena",
        startsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        totalStock: stock,
        availableStock: stock
      })
    );

    const route = target === "real" ? "/reserve" : "/naive-reserve";
    const statuses: Record<string, number> = {};
    const latencies: number[] = [];

    const started = performance.now();
    await Promise.all(
      Array.from({ length: buyers }, async (_unused, buyer) => {
        const sent = performance.now();
        const status = await postJson(`${baseUrl}${route}`, {
          concertId: concert.id,
          userId: `load_buyer_${buyer}`,
          category: "General",
          quantity: quantityFor(scenario, buyer)
        });
        latencies.push(performance.now() - sent);
        statuses[status] = (statuses[status] ?? 0) + 1;
      })
    );
    const wallMs = performance.now() - started;

    const sold = await dataSource
      .getRepository(Ticket)
      .createQueryBuilder("ticket")
      .select("COALESCE(SUM(ticket.quantity), 0)", "seats")
      .where("ticket.concertId = :concertId", { concertId: concert.id })
      .getRawOne<{ seats: number }>();
    const seatsSold = Number(sold?.seats ?? 0);
    const after = await concertRepository.findOneByOrFail({ id: concert.id });

    latencies.sort((a, b) => a - b);
    const { 201: created = 0, 409: soldOut = 0, ...otherStatuses } = statuses;

    return {
      target,
      scenario,
      buyers,
      stock,
      created,
      soldOut,
      otherStatuses,
      seatsSold,
      availableStock: after.availableStock,
      oversold: Math.max(0, seatsSold - stock),
      stockAddsUp: seatsSold + after.availableStock === stock,
      wallMs: Math.round(wallMs),
      requestsPerSecond: Math.round(buyers / (wallMs / 1000)),
      p50Ms: percentile(latencies, 0.5),
      p95Ms: percentile(latencies, 0.95),
      p99Ms: percentile(latencies, 0.99),
      maxMs: percentile(latencies, 1)
    };
  }

  const results: RunResult[] = [];
  try {
    for (const target of ["real", "naive"] as const) {
      for (const scenario of ["single", "mixed"] as const) {
        for (let run = 0; run < runs; run += 1) {
          results.push(await runOnce(target, scenario));
        }
      }
    }
  } finally {
    agent.destroy();
    server.close();
    await dataSource.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(
    `${buyers} buyers at once over ${connections} connections, ${stock} seats, ${runs} runs per row. ` +
      `"single" buys 1 seat each, "mixed" buys 1 to 5.`
  );
  console.table(
    results.map((r) => ({
      target: r.target,
      scenario: r.scenario,
      reserved: r.created,
      soldOut: r.soldOut,
      other: JSON.stringify(r.otherStatuses),
      seatsSold: r.seatsSold,
      left: r.availableStock,
      oversold: r.oversold,
      addsUp: r.stockAddsUp,
      wallMs: r.wallMs,
      "req/s": r.requestsPerSecond,
      p50: r.p50Ms,
      p95: r.p95Ms,
      p99: r.p99Ms
    }))
  );

  const realRuns = results.filter((r) => r.target === "real");
  const realFailed = realRuns.filter(
    (r) =>
      r.oversold > 0 || !r.stockAddsUp || Object.keys(r.otherStatuses).length > 0
  );
  const naiveCaught = results.some((r) => r.target === "naive" && r.oversold > 0);

  if (realFailed.length > 0) {
    console.error(`FAIL: ${realFailed.length} real run(s) oversold or lost stock.`);
    process.exit(1);
  }
  console.log(
    `PASS: ${realRuns.length} real runs, 0 seats oversold, stock adds up every time.` +
      (naiveCaught
        ? " The naive control oversold, so the test can detect the bug."
        : " Warning: the naive control did not oversell, so this load did not prove much.")
  );
}

main().catch((error) => {
  console.error("Load test failed", error);
  process.exit(1);
});
