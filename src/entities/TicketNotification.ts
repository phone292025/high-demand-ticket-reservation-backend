import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn
} from "typeorm";
import { Ticket } from "./Ticket";

export enum TicketNotificationStatus {
  Pending = "PENDING",
  Sent = "SENT",
  Skipped = "SKIPPED",
  Failed = "FAILED"
}

@Entity({ name: "ticket_notifications" })
@Index("idx_ticket_notifications_due", ["notifyAt"], {
  where: `status = 'PENDING'`
})
@Index("idx_ticket_notifications_ticket_id", ["ticketId"])
export class TicketNotification {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "integer" })
  ticketId!: number;

  @ManyToOne(() => Ticket, { onDelete: "CASCADE" })
  @JoinColumn({ name: "ticketId" })
  ticket!: Ticket;

  @Column({ type: "varchar" })
  userId!: string;

  @Column({ type: "datetime" })
  notifyAt!: Date;

  @Column({ type: "varchar", default: TicketNotificationStatus.Pending })
  status!: TicketNotificationStatus;

  @Column({ type: "datetime", nullable: true })
  sentAt!: Date | null;

  @Column({ type: "datetime", nullable: true })
  skippedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  error!: string | null;

  @CreateDateColumn({ type: "datetime" })
  createdAt!: Date;

  @UpdateDateColumn({ type: "datetime" })
  updatedAt!: Date;
}
