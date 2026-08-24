import request from "supertest";
import type { DataSource } from "typeorm";
import type { CreateAppOptions } from "../../app";
import { createApp } from "../../app";
import type {
  FirebaseAuthVerifier,
  FirebaseUser
} from "../../auth/firebase-config";
import { createDataSource, initializeDataSource } from "../../data-source";
import { Concert } from "../../entities/Concert";
import { seedConcerts } from "../../scripts/seed";
import type {
  NotificationSendResult,
  NotificationSender
} from "../../services/notification.service";
import { NotificationService } from "../../services/notification.service";

export const FIREBASE_USERS: Record<string, FirebaseUser> = {
  owner_token: { uid: "firebase_owner", email: "owner@example.test" },
  other_token: { uid: "firebase_other", email: "other@example.test" }
};

export function successfulSendResult(tokenCount = 1): NotificationSendResult {
  return { successCount: tokenCount, failureCount: 0, invalidTokens: [] };
}

export interface TestHarness {
  dataSource: DataSource;
  app: ReturnType<typeof createApp>;
  notificationSender: jest.Mocked<NotificationSender>;
  notificationService: NotificationService;
  firebaseAuthVerifier: jest.Mocked<FirebaseAuthVerifier>;
  createConcert(stock: number): Promise<Concert>;
  reserve(concertId: number, userId: string, quantity?: number): request.Test;
  authenticatedRequest(token?: string): request.Test;
  buildApp(overrides?: Partial<CreateAppOptions>): ReturnType<typeof createApp>;
  destroy(): Promise<void>;
}

/**
 * One in-memory database, migrated and seeded, plus the doubles every suite
 * needs. Each spec file owns its own harness so they stay independent.
 */
export async function createTestHarness(
  appOptions: Partial<CreateAppOptions> = {}
): Promise<TestHarness> {
  const dataSource = createDataSource(":memory:");
  await initializeDataSource(dataSource);
  await dataSource.runMigrations();
  await seedConcerts(dataSource);

  const notificationSender: jest.Mocked<NotificationSender> = {
    sendToTokens: jest.fn().mockResolvedValue(successfulSendResult())
  };
  const notificationService = new NotificationService(
    dataSource,
    notificationSender
  );
  const firebaseAuthVerifier: jest.Mocked<FirebaseAuthVerifier> = {
    verifyIdToken: jest.fn(async (idToken: string) => {
      const user = FIREBASE_USERS[idToken];

      if (!user) {
        throw new Error("Invalid token");
      }

      return user;
    })
  };

  function buildApp(overrides: Partial<CreateAppOptions> = {}) {
    return createApp(dataSource, {
      firebaseAuthVerifier,
      notificationService,
      ...overrides
    });
  }

  const app = buildApp({
    enableLegacyDemoRoutes: true,
    enablePublicCleanup: true,
    ...appOptions
  });

  return {
    dataSource,
    app,
    notificationSender,
    notificationService,
    firebaseAuthVerifier,
    buildApp,
    async createConcert(stock: number): Promise<Concert> {
      const concertRepository = dataSource.getRepository(Concert);
      return concertRepository.save(
        concertRepository.create({
          name: `Test Concert ${Date.now()} ${Math.random()}`,
          venue: "Test Venue",
          startsAt: new Date("2026-12-01T20:00:00.000Z"),
          totalStock: stock,
          availableStock: stock
        })
      );
    },
    reserve(concertId: number, userId: string, quantity = 1) {
      return request(app)
        .post("/reserve")
        .send({ concertId, userId, category: "General", quantity });
    },
    authenticatedRequest(token = "owner_token") {
      return request(app)
        .post("/api/v1/reserve")
        .set("Authorization", `Bearer ${token}`);
    },
    async destroy() {
      if (dataSource.isInitialized) {
        await dataSource.destroy();
      }
    }
  };
}
