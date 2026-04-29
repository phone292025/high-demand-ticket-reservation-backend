import "reflect-metadata";
import path from "node:path";
import { DataSource, DataSourceOptions } from "typeorm";
import { Concert } from "./entities/Concert";
import { Ticket } from "./entities/Ticket";
import { CreateConcertsAndTickets1710000000000 } from "./migrations/1710000000000-CreateConcertsAndTickets";
import { AddCategoryToTicket1710000000001 } from "./migrations/1710000000001-AddCategoryToTicket";

export function buildDataSourceOptions(database?: string): DataSourceOptions {
  return {
    type: "sqlite",
    database:
      database ??
      process.env.DB_PATH ??
      path.join(process.cwd(), "database.sqlite"),
    entities: [Concert, Ticket],
    migrations: [
      CreateConcertsAndTickets1710000000000,
      AddCategoryToTicket1710000000001
    ],
    synchronize: false,
    logging: process.env.TYPEORM_LOGGING === "true"
  };
}

export const AppDataSource = new DataSource(buildDataSourceOptions());

export function createDataSource(database: string): DataSource {
  return new DataSource(buildDataSourceOptions(database));
}

export async function configureSqlite(dataSource: DataSource): Promise<void> {
  await dataSource.query("PRAGMA foreign_keys = ON");
  await dataSource.query("PRAGMA journal_mode = WAL");
  await dataSource.query("PRAGMA busy_timeout = 5000");
}

export async function initializeDataSource(
  dataSource: DataSource = AppDataSource
): Promise<DataSource> {
  if (!dataSource.isInitialized) {
    await dataSource.initialize();
  }

  await configureSqlite(dataSource);
  return dataSource;
}
