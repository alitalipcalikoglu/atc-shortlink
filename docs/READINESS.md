# `atc-shortlink` readiness contract

## Purpose
`atc-shortlink` lets the rest of the platform turn long URLs into short, brandable, trackable links:
random or custom codes, `301`/`302` redirects with expiry and click limits, a script-free preview
page, click statistics without storing visitor addresses, and QR codes generated in-process. The
public redirect path serves end users directly on the short domain; the management API stays
behind API keys.

## Dependencies
- `atc-audit` (`AUDIT_URL` + `AUDIT_API_KEY`): optional, both-or-neither. Identical mechanism to
  `atc-flags` — `src/net/audit-client.js` is byte-identical between the two services (verified with
  `diff`). When unset, writes still succeed; when set, write events are buffered in memory and
  flushed on a 2s timer in the background, never on the request path, so an unreachable or slow
  audit service never slows down or fails a shortlink request. Buffered-and-unflushed events are
  lost on an ungraceful restart (no on-disk queue).

- Google Safe Browsing Lookup API v4 (`SAFE_BROWSING_API_KEY`, `SAFE_BROWSING_TIMEOUT_MS`):
  optional. New and changed destinations are checked and refused when listed; fail-open, an
  unreachable API accepts the URL. Empty key = no check.

No other service or external system is called by `atc-shortlink`. It never fetches redirect
destinations itself (`LinkService.#url` only validates the URL's shape).

## Persistence
Engine: SQLite via `node:sqlite`'s `DatabaseSync` (`src/db.js`), WAL journal mode, `synchronous =
NORMAL`, `busy_timeout = 5000`, foreign keys on. File location: `DB_PATH`, default
`./data/shortlink.db` (Docker image sets `/data/shortlink.db`).

Schema (one migration block, `Database.MIGRATIONS[0]`):
- `links` — one row per short code: `code` (PK), `url`, `permanent`, `enabled`, `expires_at`,
  `max_clicks`, `clicks` (counter), `last_click_at`, `tags` (JSON), `note`, `created_by`,
  `created_at`, `updated_at`; indexes `links_created(created_at DESC, code)` (keyset pagination) and
  `links_expires(expires_at)`.
- `clicks` — append-only click log: `id` (autoincrement PK), `code` (FK to `links.code`, `ON DELETE
  CASCADE`), `at`, `visitor` (HMAC, never the raw address), `referrer` (host only), `device`;
  indexes `clicks_code_at(code, at)` and `clicks_at(at)`.

Migration mechanism: identical pattern to `atc-flags` — `Database.MIGRATIONS` is an ordered array of
SQL blocks gated by `PRAGMA user_version`, each applied in its own transaction. Fresh install: file
created, all migrations run from `user_version = 0`. Upgrade: only migrations beyond the stored
`user_version` run; today there is exactly one, so both cases behave the same. No down-migration
mechanism.

## Health endpoint
`GET /health` returns `{ status: 'ok' }` unconditionally, no I/O, cannot be slow or fail while the
process is otherwise alive. Logged at `warn` level.

## Readiness endpoint
`GET /ready` calls `this.db.ping()` (`SELECT 1`), cached for `ShortlinkApi.READY_CACHE_MS =
10_000`ms — identical mechanism to `atc-flags`. A poll inside the cache window touches nothing; a stale
cache re-pings and on failure caches `{ ok: false, error }` and the route answers `503`. Safe to
poll at any interval: read-only, no mutation, no discarded in-flight work.

## Graceful shutdown
`SIGTERM`/`SIGINT` → `Application.shutdown(reason)` (idempotent guard). Order: stop the maintenance
timer → `await this.app.close()` (Fastify drains in-flight requests, including any redirect
mid-click-write) → `await this.audit.close()` (stop timer, flush what's buffered) → `this.db.close()`.
A `30_000`ms unref'd force-exit timer runs in parallel (`process.exit(1)` if shutdown hangs).
`unhandledRejection` routes through the same graceful path; `uncaughtException` calls
`process.exit(1)` immediately, skipping drain and final audit flush. PM2 `kill_timeout: 35000`ms in
`ecosystem.config.cjs` — 5s above the internal 30s force-exit, matching `atc-flags`' configuration
exactly (same comment, same numbers).

## Resource limits
- `BODY_LIMIT` (env, default `16_384` bytes / 16 KiB — smaller than `atc-flags`' 64 KiB, since link
  bodies are just a URL plus metadata, not arbitrary JSON values).
- `MAX_URL_LENGTH` (env, default `2_048`, range 64–8192) — destination URL character cap.
- `CODE_LENGTH` (env, default `7`, range 4–16) — generated code length; `LinkService.CODE_ATTEMPTS
  = 5` random-generation collision retries before giving up with a hard error telling the operator
  to raise `CODE_LENGTH`.
- `RATE_LIMIT_MAX` (env, default `600`) requests per API key per minute on `/v1/*`.
- `REDIRECT_RATE_LIMIT_MAX` (env, default `300`) requests per client address per minute on the
  public redirect/preview/QR routes.
- QR text: encoder caps input at 213 bytes (`QrTooLongError`, surfaced as `400 QR_TOO_LONG`); QR
  `scale` 1–20, `margin` 0–8 (schema-validated).
- List page size: caller-supplied `limit`, default 50, capped at 200 per the README/schema.
- `max_memory_restart: '300M'` in `ecosystem.config.cjs`.

## Timeouts
- Audit outbound call: `timeoutMs = 5_000` default (unchanged by `Application`), same as `atc-flags`.
- Shutdown force-exit: `30_000`ms, hard-coded.
- PM2 `listen_timeout: 10000`ms.
- No outward per-request timeout beyond the audit client's, because `atc-shortlink` never calls another
  service synchronously in the request path — including the redirect path itself, which only reads
  and writes its own database.

## Retry policy
Only the audit forwarding path retries, on its own background timer, never in the request path.
Same numbers as `atc-flags` (byte-identical `AuditClient`): up to `MAX_ATTEMPTS = 6` per batch, backoff
`min(30_000, 500 * 2 ** attempt)`ms (500ms → 30s), no jitter; a non-429 4xx drops the batch
permanently (logged), a 429/5xx/network error/timeout keeps it in the buffer for the next `flushMs
= 2_000`ms tick after all attempts in the current `#send` call are exhausted.

## Idempotency
- `POST /v1/links` with an explicit `slug` is **not** idempotent: repeating it fails `409
  SLUG_TAKEN`. Without a `slug` (random code), every call by definition creates a new, different
  link — there is no idempotency key to make retries safe, so a client retrying a timed-out create
  request risks creating a duplicate link for the same URL.
- `POST /v1/links` and `POST /v1/links/batch` accept an optional `Idempotency-Key` header
  (`@atc-web/atc-service-core/idempotency`, v1.30): a repeat with the same key, caller and body
  replays the stored `201` with `Idempotent-Replayed: true`, so a timed-out create retried with the
  header creates no duplicate.
- `PATCH /v1/links/:code` is idempotent in result for a fixed patch (same end state on repeat).
- `DELETE /v1/links/:code` is **not** safe to repeat: `LinkService.remove` throws `404
  LINK_NOT_FOUND` on the second call rather than treating it as a no-op.
- **`GET /:code` (the redirect / click-recording path) is emphatically not idempotent by design** —
  every successful hit inserts a `clicks` row and increments the link's counter; it is meant to be
  called once per real visit, and a client retrying a redirect request (or a link scanner following
  it twice) inflates the click count and, once `maxClicks` is set, can push a link into `exhausted`
  status earlier than a single real visit would.
- QR and read routes (`GET /v1/links*`, `/v1/stats`, `/v1/qr`) are naturally idempotent — read-only.

## Backup
State that must survive a disk loss: the SQLite file at `DB_PATH` (default `./data/shortlink.db`)
plus its WAL/SHM sidecars while running. Nothing else is durable state. No backup script exists in
this repository; capture today by stopping the process and copying the file, or via SQLite's own
online-backup mechanism (not wired up here).

## Restore
Stop the service, replace `DB_PATH` (and any stale `-wal`/`-shm` files) with the backup, start the
service — `#migrate()` applies any migrations newer than the backup's `user_version` automatically.
No ordering constraint with other services: link and click data is self-contained (codes are opaque
strings; nothing else in the platform holds a foreign key into this database).

## Metrics
`GET /metrics` (Prometheus text, `read`-role key required):
- `shortlink_links{state="active"|"inactive"}` — durable, from `links` table (`active` = enabled,
  not expired, not exhausted, computed at request time).
- `shortlink_clicks_total` — durable, `SUM(links.clicks)` (bots excluded, since `hit()` is only
  called for non-bot devices).
- `shortlink_clicks_last_hour` — durable, `COUNT(*)` on `clicks` for the last hour (bots included in
  this one, unlike `clicks_total`).
- `shortlink_click_rows` — durable, total row count in the `clicks` table.
- `shortlink_process_uptime_seconds` — process-local (`process.uptime()`), resets on restart.

Unlike `atc-flags`, `atc-shortlink` has **no process-local counters exposed in `/metrics`** — every number
above is a live database read, so restarting the process (or running a second one) does not change
what `/metrics` reports.

## Logging
Same as `atc-flags`: Fastify default request logger, `requestIdHeader: 'x-request-id'`, `genReqId:
randomUUID`, so `reqId` is on every log line per
[OBSERVABILITY.md](../../atc-stack/docs/OBSERVABILITY.md); `req.headers.authorization` redacted. Not
emitted: `traceId`, `spanId`, `route`/`op` (raw `req.url` only), `durationMs` (Fastify's own
`responseTime` field, different name), `upstream`/`upstreamMs` (no proxied upstream calls),
`service`, `version`. `code` is in every JSON error body but only additionally logged for 500s via
`request.log.error({ err }, 'unhandled error')`.

## Tracing
Accepts whatever `X-Request-Id` the caller sends (no trust gate — internal service reached only via
gateway, console or peers) and generates one when absent. Also parses an inbound `traceparent` via
`@atc-web/atc-service-core`'s `registerRequestContext`, trust-gated on `TRUST_PROXY` (same boundary as
`X-Forwarded-*`): trusted, the caller's trace-id is continued with a fresh span-id; untrusted or
malformed, a fresh trace is started. Both `traceId`/`spanId` are logged on every request line. No
outbound HTTP calls happen in the request path (the audit call is async and off-path and does not
forward any request-scoped header), so there's nothing to propagate onward regardless.

## Security model
Bearer API keys (`SHORTLINK_API_KEYS=id:secret[:role]`), compared via SHA-256 + `timingSafeEqual`
(same pattern as `atc-flags`' `ApiKeyAuth`). Roles: `read`, `write`, `readwrite`. No environment scoping
(shortlink has no environment concept — one instance, one `PUBLIC_BASE_URL`). No secret rotation
support: edit `SHORTLINK_API_KEYS` and restart. At the boundary: destination URLs must be absolute
`http(s)`, without embedded credentials, not the service's own host, not matching `BLOCKED_HOSTS`
(exact or subdomain); request bodies are schema-validated with unknown fields rejected
(`removeAdditional: false`). Visitor privacy is part of the security model even though it's not
authentication: IP + user agent are never stored, only `HMAC(HASH_SECRET, ip + userAgent)`, and
`HASH_SECRET` itself has no rotation support (rotating it changes every future visitor hash without
being able to correlate against past hashes — that's an accepted trade-off, not a bug). Out of
scope: authenticating end users following a short link (the redirect is public by design), fetching
or validating that a destination URL actually resolves (`atc-shortlink` never fetches destinations).

## Scaling model
**B — single-node stateful**: one process owns one SQLite file, `instances: 1` pinned in
`ecosystem.config.cjs` with the same "one process per SQLite file" comment as `atc-flags`.

Two instances against the same file: the **create/list/stats/read paths** are no less safe than
`atc-flags`' equivalents — SQLite's own WAL locking serializes writes across processes. The
**redirect path (`GET /:code`)** used to be the one exception (see below); as of Stage 10 it is
safe across any number of processes/connections sharing the file too, for the same reason: the
enforcement is now itself a single SQLite write, not application-level logic straddling a read and
a write.

**`maxClicks` enforcement (Stage 10 fix — atomic conditional `UPDATE`)**: `LinkService.follow()` no
longer reads the row, decides in application code, and only then writes. For every non-bot hit it
calls `LinkStore#hitIfActive(code, now)`, one statement —

```sql
UPDATE links SET clicks = clicks + 1, last_click_at = ?
WHERE code = ? AND enabled = 1 AND (expires_at IS NULL OR expires_at > ?)
  AND (max_clicks IS NULL OR clicks < max_clicks)
```

— where the "still allowed" check and the increment happen atomically, in the database, in the same
statement. SQLite guarantees this regardless of how many connections or processes are hitting the
same row at once (WAL + `busy_timeout`, see `src/db.js`): whichever attempt's `UPDATE` actually
commits first has already made `clicks < max_clicks` false for everyone still waiting, so a link
with `max_clicks = N` can never accumulate more than `N` successful (non-bot) resolves, no matter
how many processes serve its redirects concurrently. There is no process-local mutex or lock
involved anywhere in this — the correctness primitive is SQLite's own write serialization on the
conditional `UPDATE`, which is exactly why this also holds across separate processes, not just
within one. `changes === 0` doesn't say why by itself; `follow()` then does one plain, non-atomic
`byCode()` read purely to classify the failure as `LINK_NOT_FOUND`, `expired`, `disabled`, or
`exhausted` for the error response — that read cannot itself grant an extra click (the atomic
attempt already ran and failed), so it carries no race risk of its own. Bots are unaffected: they
never consume `maxClicks`, so their status check remains a plain read exactly as before (nothing
about their path was ever part of this race).

Proven with real cross-connection concurrency, not simulated in-process interleaving:
`test/concurrency.test.js` spawns several `node:worker_threads` workers, each opening its OWN
`DatabaseSync` connection to the same on-disk file, all calling `follow()` on the same code at once.
`max_clicks = 1` with 2 concurrent resolvers → exactly 1 succeeds, the other gets a deterministic
`410 LINK_GONE` ("link is exhausted"), never a corrupted or double count. `max_clicks = N` under
higher concurrency (40 resolvers, N = 10) → exactly N succeed. These tests are written to fail
against the pre-Stage-10 (`hit()`, unconditional-increment) code — they were run against it and did
fail, confirming they exercise the real race, not a vacuous check.

The housekeeping/cleanup worker (`Maintenance`, hourly `clicks.purge()`) running twice would simply
issue the same `DELETE FROM clicks WHERE at < ?` twice — wasted work, not a correctness problem,
since a `DELETE` with no matching rows the second time is a safe no-op.

## Single-node / multi-node guarantees
Running more than one `atc-shortlink` instance against the same `DB_PATH` is not a *supported, exercised
topology* (still pinned to `instances: 1` — no coordination, no shared cache, no leader election —
this is unchanged), but as of Stage 10 there is no longer a known correctness gap that a second
instance would expose: every write path, including the redirect/`maxClicks` path, is safe under
real concurrent, cross-process traffic against the same file.

## Known failure modes
- **Disk full**: a write inside `db.transaction()` throws, rolls back, and the redirect (or
  management write) fails with a `500`; the link/click tables are left in their pre-write state.
- **Audit service times out or is unreachable mid-request**: no effect on the shortlink request —
  `record()` is a synchronous in-memory push; the network call is deferred to the background timer.
  Long enough downtime drops events once `MAX_BUFFER = 5_000` is hit.
- **Process killed without graceful shutdown**: buffered-but-unflushed audit events are lost; the
  SQLite file itself should stay consistent (WAL, atomic commits), but the in-flight request being
  served gets no response, and a request whose click-insert committed but whose HTTP response never
  went out would be recorded as a click with no confirmation reaching the client.
- **Two instances run against one file**: not a topology this service is deployed as (`instances: 1`
  in `ecosystem.config.cjs`, no coordination between instances), but as of Stage 10 it is no longer
  a known correctness risk if it happened — `maxClicks` enforcement is now a single atomic
  conditional `UPDATE`, safe under concurrent cross-process writers.
