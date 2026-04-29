import "dotenv/config";
import { AppDataSource, initializeDataSource } from "./data-source";
import { createApp } from "./app";

const port = Number(process.env.PORT ?? 3000);

async function bootstrap() {
  await initializeDataSource(AppDataSource);
  const app = createApp(AppDataSource);

  app.listen(port, () => {
    console.log(`Ticket reservation API listening on http://localhost:${port}`);
  });
}

bootstrap().catch((error) => {
  console.error("Failed to start server", error);
  process.exit(1);
});
