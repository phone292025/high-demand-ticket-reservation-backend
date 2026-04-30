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
    "concerts": "GET /concerts",
    "tickets": "GET /tickets",
    "reserve": "POST /reserve",
    "createTicket": "POST /tickets",
    "purchase": "POST /purchase",
    "purchaseOptimistic": "POST /tickets/:ticketId/purchase-optimistic",
    "purchasePessimistic": "POST /tickets/:ticketId/purchase-pessimistic",
    "cleanup": "POST /cleanup"
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
  "statuses": [
    201,
    201,
    201,
    201,
    201,
    429
  ],
  "sixthResponse": {
    "status": 429,
    "body": {
      "error": "RATE_LIMITED",
      "message": "Too many reservation requests. Please try again later.",
      "ref": "542c4586-8169-49db-b365-ca849555b53e"
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
synchronize: false
```

Schema changes are handled by migrations in `src/migrations`:

1. `1710000000000-CreateConcertsAndTickets.ts`
2. `1710000000001-AddCategoryToTicket.ts`
3. `1710000000002-AddDay3TicketHardeningColumns.ts`

The second migration adds `tickets.category DEFAULT 'General'`, showing schema evolution after the first version of the ticket table.

The third migration adds `quantity`, `internal_note`, and `version` for validation, DTO safety, and optimistic locking.

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
- malformed JSON validation
- correlation ID generation and preservation
- strict Zod validation
- seeded concert listing
- successful reservation
- quantity-based stock decrement
- sold-out reservation
- concurrent reservation attempts
- safe `GET /tickets` DTOs
- optimistic and pessimistic purchase conflict handling
- Swagger spec coverage
- purchase ownership, status, and expiry checks
- cleanup of expired pending reservations
- cleanup stock cap so stock cannot exceed `totalStock`
- rollback when ticket save fails

Latest test output:

```text
Test Suites: 1 passed, 1 total
Tests:       20 passed, 20 total
Snapshots:   0 total
```

## SQLite Concurrency Note

SQLite keeps the project easy to run locally with a single database file. The app enables WAL mode and `busy_timeout` to reduce write conflicts. The reservation flow uses an atomic conditional stock update inside a transaction, which prevents overselling even under concurrent requests.

In a real production ticketing system for thousands of simultaneous users, PostgreSQL or MySQL with row-level locking, connection pooling, and stronger operational tooling would be preferred.

## Vibe Coding Reflection

AI helped speed up boilerplate for Express routes, TypeORM entities, scripts, and test structure. It also helped compare possible cleanup and indexing approaches.

The architectural decisions were manually verified. The most important manual choices were using a transaction plus atomic conditional update for reservation, keeping `synchronize: false`, using migrations for schema evolution, proving indexes with `EXPLAIN QUERY PLAN`, and proving rollback with an intentional failed ticket save.
