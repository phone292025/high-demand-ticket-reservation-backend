/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/src/tests/**/*.test.ts"],
  clearMocks: true,
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/tests/**",
    "!src/migrations/**",
    // Composition root and demo/proof CLIs.
    "!src/server.ts",
    "!src/scripts/proof-*.ts",
    "!src/scripts/explain.ts",
    "!src/scripts/stress-purchase.ts",
    "!src/scripts/run-migrations.ts",
    // Thin adapters over external services; exercised by their doubles instead
    // of by loading the real Firebase, Redis, and Sentry clients.
    "!src/auth/firebase-admin.ts",
    "!src/redis/redis-client.ts",
    "!src/observability/sentry.ts"
  ],
  coverageReporters: ["text-summary", "lcov"],
  coverageThreshold: {
    global: {
      statements: 88,
      branches: 78,
      functions: 88,
      lines: 88
    }
  }
};
