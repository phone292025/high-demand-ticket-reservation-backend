import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCategoryToTicket1710000000001 implements MigrationInterface {
  name = "AddCategoryToTicket1710000000001";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tickets" ADD "category" varchar NOT NULL DEFAULT ('General')`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_tickets_pending_expires"`);
    await queryRunner.query(`DROP INDEX "idx_tickets_concert_id"`);
    await queryRunner.query(`
      CREATE TABLE "temporary_tickets" (
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
    await queryRunner.query(`
      INSERT INTO "temporary_tickets" (
        "id",
        "concertId",
        "userId",
        "status",
        "expiresAt",
        "createdAt",
        "updatedAt"
      )
      SELECT
        "id",
        "concertId",
        "userId",
        "status",
        "expiresAt",
        "createdAt",
        "updatedAt"
      FROM "tickets"
    `);
    await queryRunner.query(`DROP TABLE "tickets"`);
    await queryRunner.query(`ALTER TABLE "temporary_tickets" RENAME TO "tickets"`);
    await queryRunner.query(
      `CREATE INDEX "idx_tickets_concert_id" ON "tickets" ("concertId")`
    );
    await queryRunner.query(
      `CREATE INDEX "idx_tickets_pending_expires" ON "tickets" ("expiresAt") WHERE status = 'PENDING'`
    );
  }
}
