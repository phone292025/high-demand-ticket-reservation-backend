import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn
} from "typeorm";

@Entity({ name: "fcm_tokens" })
@Index("idx_fcm_tokens_user_id", ["userId"])
@Index("idx_fcm_tokens_token", ["token"], { unique: true })
export class FcmToken {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  userId!: string;

  @Column({ type: "varchar" })
  token!: string;

  @CreateDateColumn({ type: "datetime" })
  createdAt!: Date;

  @UpdateDateColumn({ type: "datetime" })
  updatedAt!: Date;
}
