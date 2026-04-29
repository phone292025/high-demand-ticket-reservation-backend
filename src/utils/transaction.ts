import { DataSource, QueryRunner } from "typeorm";

class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;

    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous.catch(() => undefined);

    try {
      return await work();
    } finally {
      release();
    }
  }
}

const sqliteWriteMutex = new Mutex();

export async function runWriteTransaction<T>(
  dataSource: DataSource,
  work: (queryRunner: QueryRunner) => Promise<T>
): Promise<T> {
  return sqliteWriteMutex.runExclusive(async () => {
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const result = await work(queryRunner);
      await queryRunner.commitTransaction();
      return result;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  });
}
