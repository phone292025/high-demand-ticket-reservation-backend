import { AddressInfo } from "node:net";
import { createApp } from "../app";
import { createDataSource, initializeDataSource } from "../data-source";

async function run() {
  const dataSource = createDataSource(":memory:");
  await initializeDataSource(dataSource);
  await dataSource.runMigrations();

  const app = createApp(dataSource);
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  const correlationId = "day3-log-proof-correlation";

  try {
    const response = await fetch(`http://localhost:${port}/reserve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-ID": correlationId
      },
      body: JSON.stringify({
        concertId: 1,
        userId: "proof_user",
        quantity: 1,
        unexpectedField: "should fail strict validation"
      })
    });

    console.log(
      JSON.stringify(
        {
          expectedCorrelationIdInLogs: correlationId,
          expectedLogMessages: [
            "Request received",
            "Validation error",
            "Global error handled"
          ],
          responseStatus: response.status,
          responseBody: await response.json()
        },
        null,
        2
      )
    );
  } finally {
    server.close();
    await dataSource.destroy();
  }
}

run().catch((error) => {
  console.error("Log proof failed", error);
  process.exit(1);
});
