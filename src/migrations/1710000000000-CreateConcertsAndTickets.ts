import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateConcertsAndTickets1710000000000 implements MigrationInterface {
  name = "CreateConcertsAndTickets1710000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "concerts" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "name" varchar NOT NULL,
        "venue" varchar NOT NULL,
        "startsAt" datetime NOT NULL,
        "totalStock" integer NOT NULL,
        "availableStock" integer NOT NULL,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "tickets" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "concertId" integer NOT NULL,
        "userId" varchar NOT NULL,
        "status" varchar NOT NULL DEFAULT ('PENDING'),
        "expiresAt" datetime,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now')),
        CONSTRAINT "CHK_ticket_status" CHECK ("status" IN ('PENDING', 'COMPLETED', 'EXPIRED', 'CANCELLED')),
        CONSTRAINT "FK_tickets_concerts" FOREIGN KEY ("concertId") REFERENCES "concerts" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_tickets_concert_id" ON "tickets" ("concertId")`
    );
    await queryRunner.query(
      `CREATE INDEX "idx_tickets_pending_expires" ON "tickets" ("expiresAt") WHERE status = 'PENDING'`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_tickets_pending_expires"`);
    await queryRunner.query(`DROP INDEX "idx_tickets_concert_id"`);
    await queryRunner.query(`DROP TABLE "tickets"`);
    await queryRunner.query(`DROP TABLE "concerts"`);
  }
}
