import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn
} from "typeorm";
import { Ticket } from "./Ticket";

@Entity({ name: "concerts" })
export class Concert {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar" })
  venue!: string;

  @Column({ type: "datetime" })
  startsAt!: Date;

  @Column({ type: "integer" })
  totalStock!: number;

  @Column({ type: "integer" })
  availableStock!: number;

  @CreateDateColumn({ type: "datetime" })
  createdAt!: Date;

  @UpdateDateColumn({ type: "datetime" })
  updatedAt!: Date;

  @OneToMany(() => Ticket, (ticket) => ticket.concert)
  tickets!: Ticket[];
}
