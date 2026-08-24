import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds ticket_notifications.attempts, a composite index on tickets
 * (userId, id), and triggers keeping 0 <= availableStock <= totalStock.
 *
 * Triggers rather than a CHECK constraint: SQLite cannot add a constraint to
 * an existing table, and rebuilding concerts would drop a table that tickets
 * references ON DELETE CASCADE.
 */
export class AddNotificationRetriesAndStockGuards1710000000004 implements MigrationInterface {
  name = "AddNotificationRetriesAndStockGuards1710000000004";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ticket_notifications" ADD "attempts" integer NOT NULL DEFAULT (0)`
    );

    await queryRunner.query(
      `CREATE INDEX "idx_tickets_user_id" ON "tickets" ("userId", "id")`
    );

    await queryRunner.query(`
      CREATE TRIGGER "trg_concerts_stock_range_insert"
      BEFORE INSERT ON "concerts"
      WHEN NEW."availableStock" < 0 OR NEW."availableStock" > NEW."totalStock"
      BEGIN
        SELECT RAISE(ABORT, 'availableStock must be between 0 and totalStock');
      END
    `);

    await queryRunner.query(`
      CREATE TRIGGER "trg_concerts_stock_range_update"
      BEFORE UPDATE ON "concerts"
      WHEN NEW."availableStock" < 0 OR NEW."availableStock" > NEW."totalStock"
      BEGIN
        SELECT RAISE(ABORT, 'availableStock must be between 0 and totalStock');
      END
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER "trg_concerts_stock_range_update"`);
    await queryRunner.query(`DROP TRIGGER "trg_concerts_stock_range_insert"`);
    await queryRunner.query(`DROP INDEX "idx_tickets_user_id"`);

    await queryRunner.query(`DROP INDEX "idx_ticket_notifications_due"`);
    await queryRunner.query(`DROP INDEX "idx_ticket_notifications_ticket_id"`);
    await queryRunner.query(`
      CREATE TABLE "temporary_ticket_notifications" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "ticketId" integer NOT NULL,
        "userId" varchar NOT NULL,
        "notifyAt" datetime NOT NULL,
        "status" varchar NOT NULL DEFAULT ('PENDING'),
        "sentAt" datetime,
        "skippedAt" datetime,
        "error" varchar,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now')),
        CONSTRAINT "CHK_ticket_notification_status" CHECK ("status" IN ('PENDING', 'SENT', 'SKIPPED', 'FAILED')),
        CONSTRAINT "FK_ticket_notifications_tickets" FOREIGN KEY ("ticketId") REFERENCES "tickets" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`
      INSERT INTO "temporary_ticket_notifications" (
        "id",
        "ticketId",
        "userId",
        "notifyAt",
        "status",
        "sentAt",
        "skippedAt",
        "error",
        "createdAt",
        "updatedAt"
      )
      SELECT
        "id",
        "ticketId",
        "userId",
        "notifyAt",
        "status",
        "sentAt",
        "skippedAt",
        "error",
        "createdAt",
        "updatedAt"
      FROM "ticket_notifications"
    `);
    await queryRunner.query(`DROP TABLE "ticket_notifications"`);
    await queryRunner.query(
      `ALTER TABLE "temporary_ticket_notifications" RENAME TO "ticket_notifications"`
    );
    await queryRunner.query(
      `CREATE INDEX "idx_ticket_notifications_ticket_id" ON "ticket_notifications" ("ticketId")`
    );
    await queryRunner.query(
      `CREATE INDEX "idx_ticket_notifications_due" ON "ticket_notifications" ("notifyAt") WHERE status = 'PENDING'`
    );
  }
}
