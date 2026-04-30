import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn
} from "typeorm";
import { Concert } from "./Concert";
import { TicketStatus } from "./TicketStatus";

@Entity({ name: "tickets" })
@Check(
  "CHK_ticket_status",
  `"status" IN ('PENDING', 'COMPLETED', 'EXPIRED', 'CANCELLED')`
)
@Index("idx_tickets_concert_id", ["concertId"])
@Index("idx_tickets_pending_expires", ["expiresAt"], {
  where: `status = 'PENDING'`
})
export class Ticket {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "integer" })
  concertId!: number;

  @ManyToOne(() => Concert, (concert) => concert.tickets, { onDelete: "CASCADE" })
  @JoinColumn({ name: "concertId" })
  concert!: Concert;

  @Column({ type: "varchar" })
  userId!: string;

  @Column({ type: "varchar", default: TicketStatus.Pending })
  status!: TicketStatus;

  @Column({ type: "datetime", nullable: true })
  expiresAt!: Date | null;

  @Column({ type: "varchar", default: "General" })
  category!: string;

  @Column({ type: "integer", default: 1 })
  quantity!: number;

  @Column({ name: "internal_note", type: "varchar", nullable: true })
  internalNote!: string | null;

  @VersionColumn({ type: "integer", default: 1 })
  version!: number;

  @CreateDateColumn({ type: "datetime" })
  createdAt!: Date;

  @UpdateDateColumn({ type: "datetime" })
  updatedAt!: Date;
}
