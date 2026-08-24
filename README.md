# High-Demand Ticket Reservation Backend

Node.js, TypeScript, Express, TypeORM, and SQLite backend for a concert ticket reservation system. The important part is that stock decrement and ticket creation happen in one transaction, so a failed reservation cannot lose stock.

## Setup

PowerShell blocks npm `.ps1` shims on this machine, so use `npm.cmd`:

```powershell
npm.cmd install
npm.cmd run migration:run
npm.cmd run seed
npm.cmd run dev
```

For Redis-backed rate limiting, start Redis before `npm.cmd run dev`:

```powershell
docker run --name ticket-redis -p 6379:6379 -d redis:7-alpine
```

The API runs on:

```text
http://localhost:3000
```

The assignment web app is served by the same Express server:

```text
http://localhost:3000/app
```

Production aliases are also available locally:

```text
http://localhost:3000/api/v1
http://localhost:3000/api/v1/health
http://localhost:3000/api/v1/docs
http://localhost:3000/api-docs
```

## Firebase, Google Sign-In, FCM, And PWA

This repo now includes a vanilla Offline PWA in `src/public`. It demonstrates:

- Google Sign-In with Firebase Auth
- Firebase Cloud Messaging browser token registration
- installable PWA manifest and service worker
- cached app shell, cached concerts, and cached signed-in user tickets for offline browsing
- disabled reserve/purchase buttons while offline, so write actions are not replayed later

Create a Firebase project, enable Google as a sign-in provider, create a Web app, and enable Cloud Messaging. Add your local and deployed domains to Firebase Auth authorized domains.

Set the browser-safe Firebase web config and private Admin SDK credentials in `.env`:

```text
FIREBASE_WEB_API_KEY=
FIREBASE_AUTH_DOMAIN=
FIREBASE_PROJECT_ID=
FIREBASE_MESSAGING_SENDER_ID=
FIREBASE_APP_ID=
FIREBASE_VAPID_KEY=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=
```

Keep `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY` only in `.env`, Render secrets, or EC2 secret storage. Do not commit real Firebase Admin credentials.

Authenticated `/api/v1` user-action routes verify a Firebase ID token from:

```http
Authorization: Bearer <firebase-id-token>
```

Those routes derive `userId` from the Firebase UID. The older demo routes such as `POST /reserve`, `POST /purchase`, and public all-ticket listing are disabled by default because they trust caller-supplied `userId`. Enable them only for local proof scripts with:

```text
ENABLE_LEGACY_DEMO_ROUTES=true
ENABLE_PUBLIC_CLEANUP=true
```

## Render Free Demo

The repository includes `render.yaml` for a no-cost Render web service demo. Choose the Free instance type in Render and connect this GitHub repository.

Render runs the `Dockerfile` as one web service, so it does not run the `docker-compose.yml` Redis container. `render.yaml` keeps `ENABLE_RATE_LIMIT=true`; without `REDIS_URL`, the API uses the built-in in-memory limiter, and with Redis it uses the Redis-backed limiter proven locally by `npm.cmd run proof:rate-limit`.

The Render demo runs migrations and inserts missing seed concerts on startup:

```text
RUN_MIGRATIONS_ON_START=true
SEED_ON_START=true
```

### The Render free plan has no persistent disk

The free instance type gives no attached disk, so `/app/data/database.sqlite`
lives in the container filesystem. **Every deploy and every idle spin-down
starts from an empty database.** Concerts reappear because they are re-seeded
on boot; reservations, purchases, and FCM registrations do not. Disappearing
tickets on the Render demo are the hosting plan, not a bug in the reservation
logic.

For durable data, attach a Render disk (paid) or move to Postgres.

## Production Launch

The final production shape is one larger EC2 instance in `ap-southeast-1`:

```text
Host Nginx + Certbot
Docker API container
Docker Redis container
Separate /opt/sentry self-hosted Sentry stack
/opt/ticket-api app deployment folder
GitHub Actions deploy over SSH
```

Public routes:

```text
https://your-name.int.yt/api/v1
https://your-name.int.yt/docs
https://sentry-your-name.int.yt
```

Production `.env` stays only on EC2. GitHub Actions runs build/test on every push. EC2 deployment is manual from the GitHub Actions page, so it will not fail or create cloud expectations when no paid EC2 server exists.

The API Docker Compose file binds the Node API to `127.0.0.1:3000` and keeps Redis private inside Docker. Nginx is the public entrypoint for HTTPS traffic.

Use these deployment assets:

```text
Dockerfile
docker-compose.yml
.env.example
deploy/nginx/ticket-api.conf
deploy/nginx/sentry.conf
.github/workflows/deploy.yml
```

The Sentry verification endpoint is:

```http
POST /api/v1/debug/concurrency-error
X-Debug-Secret: your-secret
```

It is disabled when `DEBUG_SECRET` is missing, returns `403` for a wrong secret, and throws a `ConcurrencyError` for Sentry verification when the secret is correct.

## Project Summary

### How Double-Selling Is Prevented

The reservation endpoint does not read stock first and then update it later. That pattern can oversell when many users click at the same time.

Instead, `POST /reserve` uses `queryRunner.startTransaction()` and performs one atomic conditional update:

```sql
UPDATE concerts
SET availableStock = availableStock - :quantity
WHERE id = :concertId
AND availableStock >= :quantity;
```

If SQLite reports `affected rows = 1`, stock was safely reserved and the API creates the `PENDING` ticket in the same transaction. If `affected rows = 0`, not enough stock was available, so the transaction rolls back and the API returns `409 SOLD_OUT`.

The implementation also uses a small in-process write mutex around SQLite write transactions. This is included because SQLite is file-based and uses one TypeORM connection in this project. The mutex reduces local write contention, while the real correctness guarantee still comes from the database transaction plus the atomic conditional stock update.

### Why These Columns Were Indexed

`tickets.concertId` has a normal SQLite B-tree index:

```sql
CREATE INDEX idx_tickets_concert_id ON tickets(concertId);
```

This was chosen because ticket records are commonly filtered by concert. As the tickets table grows, this prevents full table scans for queries such as:

```sql
SELECT * FROM tickets WHERE concertId = ?;
```

Cleanup also needs to find expired pending reservations quickly, so the project uses:

```sql
CREATE INDEX idx_tickets_pending_expires
ON tickets(expiresAt)
WHERE status = 'PENDING';
```

The partial condition is `WHERE status = 'PENDING'`, so the index only contains pending tickets. The indexed key is `expiresAt` because cleanup searches for pending reservations whose expiration time has passed.

### Why The Partial Index Helps Cleanup

A normal status index would include `PENDING`, `COMPLETED`, `EXPIRED`, and `CANCELLED` rows. Cleanup only needs expired `PENDING` rows, so indexing every status stores unnecessary data.

The partial index is smaller, cheaper to maintain, and faster for this cleanup query:

```sql
SELECT *
FROM tickets
WHERE status = 'PENDING'
AND expiresAt < ?;
```

### EXPLAIN QUERY PLAN Proof

`npm.cmd run explain` proves SQLite uses both indexes:

```text
Concert ticket lookup plan:
- SEARCH tickets USING INDEX idx_tickets_concert_id (concertId=?)
Expired pending cleanup plan:
- SEARCH tickets USING INDEX idx_tickets_pending_expires (expiresAt<?)
```

The important part is `SEARCH tickets USING INDEX`, not `SCAN tickets`.

### Vibe Coding Impact

AI helped speed up boilerplate for Express routes, TypeORM entities, scripts, README wording, and test structure.

AI could have hindered the architecture if its first suggestion was accepted blindly. The concurrency-sensitive parts were manually verified: the reservation flow uses an atomic conditional update, stock decrement and ticket creation are inside one transaction, migrations are used instead of `synchronize: true`, and indexes are proven with `EXPLAIN QUERY PLAN`.

## API

```http
GET /
GET /health
```

`GET /` returns a small API index for browser testing:

```json
{
  "name": "High-Demand Ticket Reservation Backend",
  "status": "ok",
  "endpoints": {
    "health": "GET /health",
    "healthV1": "GET /api/v1/health",
    "concerts": "GET /concerts",
    "concertsV1": "GET /api/v1/concerts",
    "tickets": "GET /tickets",
    "ticketsV1": "GET /api/v1/tickets",
    "reserve": "POST /reserve",
    "reserveV1": "POST /api/v1/reserve",
    "createTicket": "POST /tickets",
    "createTicketV1": "POST /api/v1/tickets",
    "purchase": "POST /purchase",
    "purchaseV1": "POST /api/v1/purchase",
    "purchaseOptimistic": "POST /tickets/:ticketId/purchase-optimistic",
    "purchaseOptimisticV1": "POST /api/v1/tickets/:ticketId/purchase-optimistic",
    "purchasePessimistic": "POST /tickets/:ticketId/purchase-pessimistic",
    "purchasePessimisticV1": "POST /api/v1/tickets/:ticketId/purchase-pessimistic",
    "cleanup": "POST /cleanup",
    "cleanupV1": "POST /api/v1/cleanup",
    "app": "GET /app",
    "firebaseConfig": "GET /api/v1/firebase-config",
    "myTickets": "GET /api/v1/me/tickets",
    "fcmTokens": "POST /api/v1/me/fcm-tokens",
    "docs": "GET /api-docs",
    "docsV1": "GET /api/v1/docs"
  }
}
```

`GET /health` returns:

```json
{
  "status": "ok"
}
```

```http
GET /concerts
GET /tickets
POST /reserve
POST /tickets
POST /purchase
POST /tickets/:ticketId/purchase-optimistic
POST /tickets/:ticketId/purchase-pessimistic
POST /cleanup
GET /api/v1
GET /api/v1/health
GET /api/v1/concerts
GET /api/v1/tickets
GET /api/v1/me/tickets
GET /api/v1/firebase-config
POST /api/v1/reserve
POST /api/v1/tickets
POST /api/v1/purchase
POST /api/v1/tickets/:ticketId/purchase-optimistic
POST /api/v1/tickets/:ticketId/purchase-pessimistic
POST /api/v1/me/fcm-tokens
POST /api/v1/cleanup
GET /app
GET /docs
```

Reserve request:

```json
{
  "concertId": 1,
  "userId": "user_123",
  "category": "VIP",
  "quantity": 2
}
```

Reserve response:

```json
{
  "ticket": {
    "id": 1,
    "concertId": 1,
    "userId": "user_123",
    "status": "PENDING",
    "category": "VIP",
    "quantity": 2
  }
}
```

A successful reservation creates a `PENDING` ticket with `expiresAt` set to 5 minutes after the reservation time.

`POST /tickets` is an alias of `POST /reserve`. Both routes use the same Redis rate limiter and the same reservation service method.

Purchase request:

```json
{
  "ticketId": 1,
  "userId": "user_123"
}
```

Purchase response:

```json
{
  "ticket": {
    "id": 1,
    "status": "COMPLETED"
  }
}
```

Authenticated reserve request for `POST /api/v1/reserve`:

```json
{
  "concertId": 1,
  "category": "VIP",
  "quantity": 2
}
```

Authenticated purchase request for `POST /api/v1/purchase`:

```json
{
  "ticketId": 1
}
```

Register a browser for FCM reminders:

```json
{
  "token": "firebase-cloud-messaging-registration-token"
}
```

Pending reservations create a notification record. The server worker checks due records every 30 seconds and sends an FCM reminder about one minute before `expiresAt`. Completed or expired tickets are skipped.

Cleanup response:

```json
{
  "expiredCount": 2,
  "releasedByConcert": {
    "1": 1,
    "3": 1
  }
}
```

Global error response format:

```json
{
  "error": "VALIDATION_ERROR",
  "message": "Invalid request body",
  "ref": "same-correlation-id-from-response-header"
}
```

## Production Hardening Pass

A full audit of the repository turned up twenty findings; all are fixed. The
three at the top were correct on localhost and wrong under the deployment setup
this repo ships, and none were visible from the passing test suite.

### Breaks in production

**Proxy-aware client IPs.** Express defaults `trust proxy` to `false`, so behind
the shipped nginx every request resolved to the proxy socket address and
`express-rate-limit` keyed them all to one bucket — the intended 5 reservations
per minute _per user_ was 5 per minute for the entire internet. The app now
reads `TRUST_PROXY_HOPS` (1 behind nginx and Render, 0 for a direct local run),
and `rate-limit.test.ts` asserts that distinct forwarded clients get distinct
buckets.

**Scheduled reservation cleanup.** `CleanupService` was correct and tested, but
its only caller was `POST /cleanup`, which is disabled in production. Abandoned
reservations therefore held their stock forever. `startCleanupWorker` now runs
the sweep on an interval next to the notification worker, and a test proves
stock returns without anyone calling the route.

**API docs in the container.** `swagger-jsdoc` was pointed at `src/app.ts`, a
path resolved against the working directory — and the runtime image ships only
`dist`. Every route annotation was silently dropped, so `/docs` rendered zero
endpoints in production. Paths are now resolved relative to the module.

### Degrades under real use

- **Firebase ID token refresh.** The web app captured one token at sign-in and
  reused it forever; tokens expire after an hour, so every call 401'd until the
  user reloaded. `apiFetch` now asks the SDK for a token per request.
- **Honest push delivery.** `sendEachForMulticast` resolves even when every
  token fails. The per-token results are now inspected: rows are marked `SENT`
  only if at least one token succeeded, permanently invalid tokens are pruned,
  and failures retry up to `MAX_NOTIFICATION_ATTEMPTS` before going terminal.
- **Rate limiter ahead of auth.** Auth used to run first, so unauthenticated
  floods bypassed throttling entirely while costing a Firebase verification
  each. A global limiter now fronts the router.
- **Security headers.** `helmet()` plus a Firebase-aware CSP scoped to `/app`
  (Swagger UI ships inline scripts and stays outside it), and `X-Powered-By` is
  off. COOP is `same-origin-allow-popups` so Google sign-in still works.
- **Dependencies.** 30 advisories (1 critical, 9 high) down to 6 moderate, none
  high or critical: `typeorm` 0.3.31, `sqlite3` 6, `firebase-admin` 14. CI now
  fails on `npm audit --omit=dev --audit-level=high`.

### Correctness and operations

- `tickets (userId, id)` is indexed — `GET /api/v1/me/tickets` was the last hot
  query still doing a full table scan.
- Graceful shutdown stops background workers _before_ destroying the
  DataSource, handles `SIGINT` as well as `SIGTERM`, and force-exits on a timer
  so a keep-alive connection cannot hang the container into a `SIGKILL`.
- TypeORM `OptimisticLockVersionMismatchError` and `SQLITE_BUSY` now map to 409
  instead of 500, so an ordinary lost race stops paging Sentry.
- Stock arithmetic uses bound parameters instead of string interpolation.
- Database triggers enforce `0 <= availableStock <= totalStock`, so oversell is
  impossible at the storage layer, not only in application code.
- `GET /health/ready` checks the database and Redis and returns 503 when either
  is unusable; the Dockerfile healthcheck and the deploy smoke test both gate on
  it rather than on the unconditional `/health`.
- The debug secret is compared with `crypto.timingSafeEqual`, and FCM
  registrations are capped per user.

### Guardrails

ESLint with `typescript-eslint`, a Jest coverage threshold, and the one test
suite split into nine by concern. CI runs lint, type check, build, coverage, and
the production audit on every push and pull request.

## Where This Runs

| Surface | Hosts                          | Notes                                                                                                                 |
| ------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Vercel  | The PWA at `/app`, on the CDN  | `/api/*` and `/docs/*` are rewritten to the Render backend, so the browser stays same-origin and no CORS is involved. |
| Render  | The Express API and SQLite     | Free plan: no persistent disk, see the caveat above.                                                                  |
| EC2     | nginx + Docker Compose + Redis | The full production shape, deployed manually from GitHub Actions.                                                     |

The stateful API is deliberately **not** deployed to Vercel. Oversell
prevention depends on one process holding a write mutex over one SQLite file;
serverless functions have an ephemeral per-instance `/tmp`, no shared
filesystem, and no long-lived `setInterval`, so the cleanup and notification
workers would never run and the concurrency guarantee would not hold.

If the Render service is renamed, update the two rewrite destinations in
`vercel.json`, and add the Vercel domain to the Firebase console's authorized
domains so Google sign-in works there.

## Hardening

### Correlation IDs And Logging

Every request receives an `X-Correlation-ID`. If the client does not send one, the API generates a UUID and returns it in the response header.

The project uses `AsyncLocalStorage` so Pino JSON logs automatically include `correlation_id` without passing it through service functions.

Example validation failure log flow:

```powershell
npm.cmd run proof:logs
```

```json
{"correlation_id":"day3-log-proof-correlation","msg":"Request received","method":"POST","path":"/reserve"}
{"correlation_id":"day3-log-proof-correlation","msg":"Validation error","error":"VALIDATION_ERROR"}
{"correlation_id":"day3-log-proof-correlation","msg":"Global error handled","error":"VALIDATION_ERROR"}
```

### Validation And DTO Safety

`POST /reserve` and `POST /tickets` use strict Zod validation:

- `concertId`: positive integer
- `userId`: non-empty string
- `category`: non-empty string, default `General`
- `quantity`: integer from `1` to `5`
- unknown properties are rejected

`GET /tickets` uses a response DTO and never returns the database-only `internalNote` or `version` fields.

### Redis Rate Limit Proof

Both reservation creation endpoints are limited to 5 requests per minute per IP:

```http
POST /reserve
POST /tickets
```

Redis was started with:

```powershell
docker run --name ticket-redis -p 6379:6379 -d redis:7-alpine
```

Redis container check:

```text
NAMES          STATUS         PORTS
ticket-redis   Up 7 minutes   0.0.0.0:6379->6379/tcp, [::]:6379->6379/tcp
```

Then the proof script was run:

```powershell
npm.cmd run proof:rate-limit
```

Actual result from the latest run:

```json
{
  "scenario": "Six reservation requests within one minute",
  "expected": "First five allowed, sixth returns 429 RATE_LIMITED",
  "statuses": [201, 201, 201, 201, 201, 429],
  "sixthResponse": {
    "status": 429,
    "body": {
      "error": "RATE_LIMITED",
      "message": "Too many reservation requests. Please try again later.",
      "ref": "4d5a3640-278f-478f-b87f-a14e23c14260"
    }
  }
}
```

This proves Redis-backed rate limiting is active: the first five reservation requests were accepted, and the sixth request in the same minute was blocked with `429 RATE_LIMITED`.

### Optimistic And Pessimistic Purchase

Optimistic purchase uses an explicit version-based conditional update:

```sql
UPDATE tickets
SET status = 'COMPLETED',
    version = version + 1
WHERE id = :ticketId
AND userId = :userId
AND status = 'PENDING'
AND version = :currentVersion
AND expiresAt > :now;
```

If `affected rows = 0`, the API returns `409 LOCK_CONFLICT`.

The pessimistic endpoint is implemented for testing, but SQLite does not provide true `SELECT FOR UPDATE` row-level locking. The project uses serialized transaction behavior as a SQLite-safe fallback. In production, PostgreSQL/MySQL would be used for real row-level locking.

Stress test:

```powershell
npm.cmd run stress:purchase
```

Expected result:

```text
Two simultaneous purchase requests for the same pending ticket:
- one 200 COMPLETED
- one 409 LOCK_CONFLICT
```

### Swagger And Shutdown

Swagger UI is available at:

```text
http://localhost:3000/api-docs
```

This Express project uses OpenAPI JSDoc to avoid a large framework refactor while still exposing request bodies, success DTOs, and conflict responses in Swagger UI.

The server handles `SIGTERM` by stopping new requests, waiting 5 seconds for in-flight work, closing SQLite, closing Redis, and exiting.

## Database And Migrations

TypeORM is configured with:

```ts
synchronize: false;
```

Schema changes are handled by migrations in `src/migrations`:

1. `1710000000000-CreateConcertsAndTickets.ts`
2. `1710000000001-AddCategoryToTicket.ts`
3. `1710000000002-AddDay3TicketHardeningColumns.ts`
4. `1710000000003-AddFirebasePwaNotifications.ts`

The second migration adds `tickets.category DEFAULT 'General'`, showing schema evolution after the first version of the ticket table.

The third migration adds `quantity`, `internal_note`, and `version` for validation, DTO safety, and optimistic locking.

The fourth migration adds `fcm_tokens` and `ticket_notifications` for Firebase Cloud Messaging expiry reminders.

The migrations were created through the TypeORM migration workflow instead of relying on automatic synchronization.

Seed data is created with:

```powershell
npm.cmd run seed
```

Running the seed script also restores the three demo concerts to their default stock values, which makes repeated local testing easier.

Seeded concerts:

```text
Rock Night 2026, stock 5
APU Live Concert, stock 10
VIP Acoustic Show, stock 2
```

## Double-Selling Protection

The reservation flow uses `queryRunner.startTransaction()` and an atomic conditional stock update:

```sql
UPDATE concerts
SET availableStock = availableStock - :quantity
WHERE id = :concertId
AND availableStock >= :quantity;
```

If `affected rows = 1`, the API creates a `PENDING` ticket in the same transaction and commits. If `affected rows = 0`, the transaction rolls back and the API returns `409 SOLD_OUT`.

The stock decrement and ticket insert are not separate standalone operations. If ticket creation fails after stock is decremented, the transaction rolls back and stock is restored.

## Indexing

The tickets table has a normal SQLite B-tree index:

```sql
CREATE INDEX idx_tickets_concert_id ON tickets(concertId);
```

This helps queries that filter tickets by concert:

```sql
SELECT * FROM tickets WHERE concertId = ?;
```

The cleanup task uses a partial index:

```sql
CREATE INDEX idx_tickets_pending_expires
ON tickets(expiresAt)
WHERE status = 'PENDING';
```

This is better than a full status index for cleanup because cleanup only cares about expired `PENDING` reservations. A full index would include completed, expired, and cancelled tickets that cleanup never needs. The partial index is smaller, cheaper to maintain, and faster to search for pending expirations.

The partial condition is `WHERE status = 'PENDING'`, so the index only contains pending tickets. The indexed key is `expiresAt` because cleanup needs to find expired pending reservations quickly.

## EXPLAIN QUERY PLAN Output

Run:

```powershell
npm.cmd run explain
```

Output:

```text
Concert ticket lookup plan:
- SEARCH tickets USING INDEX idx_tickets_concert_id (concertId=?)
Expired pending cleanup plan:
- SEARCH tickets USING INDEX idx_tickets_pending_expires (expiresAt<?)
```

This proves SQLite is using both required indexes instead of scanning the whole tickets table.

## Rollback Proof

Run:

```powershell
npm.cmd run proof:rollback
```

Output:

```text
Before reserve: availableStock = 1
Stock will be decreased inside a transaction.
Ticket save failed intentionally.
Failure: SQLITE_CONSTRAINT: CHECK constraint failed: CHK_ticket_status
Transaction rolled back.
After rollback: availableStock = 1
Proof tickets saved: 0
```

The script intentionally creates an invalid ticket status after decrementing stock inside the transaction. SQLite rejects the ticket insert, TypeORM rolls back, and stock remains `1`.

## Tests

Run:

```powershell
npm.cmd run test
```

The integration tests cover:

- `GET /health`
- `GET /` API index
- `/api/v1` production aliases
- `/docs` Swagger alias
- malformed JSON validation
- correlation ID generation and preservation
- strict Zod validation
- protected `ConcurrencyError` debug endpoint
- seeded concert listing
- successful reservation
- quantity-based stock decrement
- sold-out reservation
- concurrent reservation attempts
- safe `GET /tickets` DTOs
- optimistic and pessimistic purchase conflict handling
- Swagger spec coverage
- purchase ownership, status, and expiry checks
- Firebase Auth protected user-action routes
- per-user `GET /api/v1/me/tickets`
- FCM token registration
- notification scheduling, sending, and skip behavior
- cleanup of expired pending reservations
- cleanup stock cap so stock cannot exceed `totalStock`
- rollback when ticket save fails

Latest test output:

```text
Test Suites: 9 passed, 9 total
Tests:       71 passed, 71 total
Snapshots:   0 total

Statements   : 93.15%
Branches     : 81.48%
Functions    : 91.40%
Lines        : 93.28%
```

Coverage thresholds are enforced in `jest.config.js`; CI fails below them.

Latest Docker smoke test:

```text
docker compose config: passed
docker build -t ticket-api-production-test .: passed
docker compose run --rm api node dist/scripts/run-migrations.js: passed
curl http://127.0.0.1:3000/api/v1/health: {"status":"ok"}
```

## SQLite Concurrency Note

SQLite keeps the project easy to run locally with a single database file. The app enables WAL mode and `busy_timeout` to reduce write conflicts. The reservation flow uses an atomic conditional stock update inside a transaction, which prevents overselling even under concurrent requests.

In a real production ticketing system for thousands of simultaneous users, PostgreSQL or MySQL with row-level locking, connection pooling, and stronger operational tooling would be preferred.

## Vibe Coding Reflection

AI helped speed up boilerplate for Express routes, TypeORM entities, scripts, and test structure. It also helped compare possible cleanup and indexing approaches.

The architectural decisions were manually verified. The most important manual choices were using a transaction plus atomic conditional update for reservation, keeping `synchronize: false`, using migrations for schema evolution, proving indexes with `EXPLAIN QUERY PLAN`, and proving rollback with an intentional failed ticket save.
