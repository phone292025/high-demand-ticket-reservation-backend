import { MigrationInterface, QueryRunner } from "typeorm";

export class AddFirebasePwaNotifications1710000000003
  implements MigrationInterface
{
  name = "AddFirebasePwaNotifications1710000000003";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "fcm_tokens" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "userId" varchar NOT NULL,
        "token" varchar NOT NULL,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_fcm_tokens_user_id" ON "fcm_tokens" ("userId")`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_fcm_tokens_token" ON "fcm_tokens" ("token")`
    );

    await queryRunner.query(`
      CREATE TABLE "ticket_notifications" (
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
    await queryRunner.query(
      `CREATE INDEX "idx_ticket_notifications_ticket_id" ON "ticket_notifications" ("ticketId")`
    );
    await queryRunner.query(
      `CREATE INDEX "idx_ticket_notifications_due" ON "ticket_notifications" ("notifyAt") WHERE status = 'PENDING'`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_ticket_notifications_due"`);
    await queryRunner.query(`DROP INDEX "idx_ticket_notifications_ticket_id"`);
    await queryRunner.query(`DROP TABLE "ticket_notifications"`);
    await queryRunner.query(`DROP INDEX "idx_fcm_tokens_token"`);
    await queryRunner.query(`DROP INDEX "idx_fcm_tokens_user_id"`);
    await queryRunner.query(`DROP TABLE "fcm_tokens"`);
  }
}
