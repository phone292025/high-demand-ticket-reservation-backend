import "dotenv/config";
import { AppDataSource, initializeDataSource } from "../data-source";
import { formatSqliteDate } from "../utils/date";

function printPlan(title: string, rows: Array<Record<string, unknown>>) {
  console.log(title);
  for (const row of rows) {
    console.log(`- ${row.detail ?? JSON.stringify(row)}`);
  }
}

async function run() {
  const dataSource = await initializeDataSource(AppDataSource);

  const concertLookupPlan = await dataSource.query(
    "EXPLAIN QUERY PLAN SELECT * FROM tickets WHERE concertId = ?",
    [1]
  );

  const cleanupPlan = await dataSource.query(
    "EXPLAIN QUERY PLAN SELECT * FROM tickets WHERE status = 'PENDING' AND expiresAt < ?",
    [formatSqliteDate(new Date())]
  );

  printPlan("Concert ticket lookup plan:", concertLookupPlan);
  printPlan("Expired pending cleanup plan:", cleanupPlan);

  await dataSource.destroy();
}

run().catch((error) => {
  console.error("Explain failed", error);
  process.exit(1);
});
