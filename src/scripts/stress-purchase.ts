import { AddressInfo } from "node:net";
import { createApp } from "../app";
import { createDataSource, initializeDataSource } from "../data-source";
import { Concert } from "../entities/Concert";

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

  const concert = await dataSource.getRepository(Concert).save(
    dataSource.getRepository(Concert).create({
      name: "Stress Test Final Ticket",
      venue: "Test Venue",
      startsAt: new Date("2026-12-01T20:00:00.000Z"),
      totalStock: 1,
      availableStock: 1
    })
  );

  const app = createApp(dataSource);
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://localhost:${port}`;

  try {
    const reservation = await postJson(`${baseUrl}/reserve`, {
      concertId: concert.id,
      userId: "stress_user",
      category: "General",
      quantity: 1
    });

    const ticketId = reservation.body.ticket.id;
    const [requestA, requestB] = await Promise.all([
      postJson(`${baseUrl}/tickets/${ticketId}/purchase-optimistic`, {
        userId: "stress_user"
      }),
      postJson(`${baseUrl}/tickets/${ticketId}/purchase-optimistic`, {
        userId: "stress_user"
      })
    ]);

    console.log(
      JSON.stringify(
        {
          scenario: "Two simultaneous optimistic purchases for the final ticket",
          reservationStatus: reservation.status,
          requestA,
          requestB,
          conclusion:
            "Expected one 200 COMPLETED response and one 409 LOCK_CONFLICT response."
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
  console.error("Stress purchase proof failed", error);
  process.exit(1);
});
