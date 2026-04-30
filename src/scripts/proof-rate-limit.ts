import { AddressInfo } from "node:net";
import { createApp } from "../app";
import { createDataSource, initializeDataSource } from "../data-source";
import { createRedisClient, closeRedisClient } from "../redis/redis-client";
import { seedConcerts } from "./seed";

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  return {
    status: response.status,
    body: await response.json()
  };
}

async function run() {
  const dataSource = createDataSource(":memory:");
  await initializeDataSource(dataSource);
  await dataSource.runMigrations();
  await seedConcerts(dataSource);

  const redisClient = await createRedisClient();
  const app = createApp(dataSource, {
    enableRateLimit: true,
    redisClient,
    rateLimitPrefix: `ticket-reserve-limit-proof:${Date.now()}:`
  });
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://localhost:${port}`;

  try {
    const results = [];

    for (let index = 1; index <= 6; index += 1) {
      results.push(
        await postJson(`${baseUrl}/reserve`, {
          concertId: 2,
          userId: `rate_limit_user_${index}`,
          category: "General",
          quantity: 1
        })
      );
    }

    console.log(
      JSON.stringify(
        {
          scenario: "Six reservation requests within one minute",
          expected: "First five allowed, sixth returns 429 RATE_LIMITED",
          statuses: results.map((result) => result.status),
          sixthResponse: results[5]
        },
        null,
        2
      )
    );
  } finally {
    server.close();
    await closeRedisClient(redisClient);
    await dataSource.destroy();
  }
}

run().catch((error) => {
  console.error("Rate limit proof failed", error);
  console.error(
    "Start Redis first: docker run --name ticket-redis -p 6379:6379 -d redis:7-alpine"
  );
  process.exit(1);
});
