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
SET availableStock = availableStock - 1
WHERE id = ? AND availableStock > 0;
```

If SQLite reports `affected rows = 1`, stock was safely reserved and the API creates the `PENDING` ticket in the same transaction. If `affected rows = 0`, no stock was available, so the transaction rolls back and the API returns `409 Sold Out`.

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
    "reserve": "POST /reserve",
    "purchase": "POST /purchase",
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
POST /reserve
POST /purchase
POST /cleanup
```

Reserve request:

```json
{
  "concertId": 1,
  "userId": "user_123",
  "category": "VIP"
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
    "category": "VIP"
  }
}
```

A successful reservation creates a `PENDING` ticket with `expiresAt` set to 5 minutes after the reservation time.

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

## Database And Migrations

TypeORM is configured with:

```ts
synchronize: false
```

Schema changes are handled by migrations in `src/migrations`:

1. `1710000000000-CreateConcertsAndTickets.ts`
2. `1710000000001-AddCategoryToTicket.ts`

The second migration adds `tickets.category DEFAULT 'General'`, showing schema evolution after the first version of the ticket table.

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
SET availableStock = availableStock - 1
WHERE id = ? AND availableStock > 0;
```

If `affected rows = 1`, the API creates a `PENDING` ticket in the same transaction and commits. If `affected rows = 0`, the transaction rolls back and the API returns `409 Sold Out`.

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
- seeded concert listing
- successful reservation
- sold-out reservation
- concurrent reservation attempts
- purchase ownership, status, and expiry checks
- cleanup of expired pending reservations
- cleanup stock cap so stock cannot exceed `totalStock`
- rollback when ticket save fails

Latest test output:

```text
Test Suites: 1 passed, 1 total
Tests:       12 passed, 12 total
Snapshots:   0 total
```

## SQLite Concurrency Note

SQLite keeps the project easy to run locally with a single database file. The app enables WAL mode and `busy_timeout` to reduce write conflicts. The reservation flow uses an atomic conditional stock update inside a transaction, which prevents overselling even under concurrent requests.

In a real production ticketing system for thousands of simultaneous users, PostgreSQL or MySQL with row-level locking, connection pooling, and stronger operational tooling would be preferred.

## Vibe Coding Reflection

AI helped speed up boilerplate for Express routes, TypeORM entities, scripts, and test structure. It also helped compare possible cleanup and indexing approaches.

The architectural decisions were manually verified. The most important manual choices were using a transaction plus atomic conditional update for reservation, keeping `synchronize: false`, using migrations for schema evolution, proving indexes with `EXPLAIN QUERY PLAN`, and proving rollback with an intentional failed ticket save.
