import { AppDataSource, initializeDataSource } from "../data-source";

async function run() {
  await initializeDataSource(AppDataSource);
  const migrations = await AppDataSource.runMigrations();

  if (migrations.length === 0) {
    console.log("No pending migrations.");
  } else {
    console.log(
      `Ran migrations: ${migrations.map((migration) => migration.name).join(", ")}`
    );
  }
}

run()
  .catch((error) => {
    console.error("Migration run failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy();
    }
  });
