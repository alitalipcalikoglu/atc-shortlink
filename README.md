# atc-shortlink

Short links for applications: random codes or custom slugs, `301`/`302` redirects with expiry and click limits, a `+` preview page, click statistics without storing addresses, and QR codes as SVG or PNG from a built-in encoder. HTTP only; the public side runs on your short domain, the management API stays behind API keys.

Runtime dependencies: `fastify`, `@fastify/rate-limit`. Storage is SQLite via `node:sqlite` (built into Node 22.13+). The folder is self-contained: copy it to any host with Node 22 and run.

## Run

```bash
cp .env.example .env        # set SHORTLINK_API_KEYS, PUBLIC_BASE_URL, HASH_SECRET
npm ci
npm run dev
```

Production with PM2 (reads `./.env` through Node's `--env-file`):

```bash
npm ci --omit=dev
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

Production with Docker (mount the database directory):

```bash
docker build -t atc-shortlink .
docker run -p 3006:3006 -v atc-shortlink-data:/data --env-file .env atc-shortlink
```

Tests and type check:

```bash
npm test
npm run typecheck
```

## Model

- **A link** is `code → url` with `permanent` (301 vs 302), `enabled`, `expiresAt`, `maxClicks`, `tags`, `note`, and counters. Its `status` is `active`, `disabled`, `expired` or `exhausted`; only `active` links redirect, the rest answer `410 Gone`.
- **Codes** are `CODE_LENGTH` random base62 characters or caller-chosen slugs (3–64 chars). Paths the service uses (`v1`, `health`, `metrics`, `qr`, …) are reserved.
- **Preview**: `/<code>+` is a script-free HTML page showing the destination, dates and QR before following. Not counted as a click.
- **Clicks** store time, referrer host, device class and `HMAC(HASH_SECRET, ip + user agent)`; never the address or agent. Bot-like agents are logged as `bot`, do not increment the counter and do not consume `maxClicks`.
- **QR**: `/<code>/qr` (public, SVG or PNG) and `/v1/qr?text=` (any text, up to 213 bytes). Strong ETag, one-day cache.
- **Keys** are `id:secret[:role]`; the id becomes `createdBy`. Roles `read`, `write`, `readwrite`.

## Boundaries

**Purpose:** short URLs with click tracking.

**Responsibilities:** create/manage links; redirect; click counting; expiry and max-click limits; QR codes.

**Non-responsibilities:** not an analytics platform — click counts only, no referrer/funnel analysis. The max-click limit is enforced by an atomic conditional SQL `UPDATE`, not a read-then-write check — safe under concurrent hits on the same code, including across separate processes/connections sharing the database (see "Scaling model" below). Not a general redirect/proxy service beyond its own link table.

## API

Errors are JSON: `{ "error": { "code", "message", "details?" } }`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health`, `/ready`, `/v1/info` | none | Liveness; readiness (database, cached 10 s); service identity (version, API version, capabilities, schema version, service-core version). |
| GET | `/:code` | none | Redirect (`302`, or `301` when permanent). `HEAD` too. `404` unknown, `410` gone. |
| GET | `/:code+` | none | Preview page. |
| GET | `/:code/qr` | none | QR of the short URL, `format=svg|png`, `scale=1..20`, `margin=0..8`. Active links only. |
| GET | `/robots.txt` | none | Disallow all. |
| POST | `/v1/links` | write | `{ url, slug?, permanent?, expiresAt?, maxClicks?, tags?, note? }` → `201 { link }`. |
| GET | `/v1/links` | read | Newest first; `q`, `tag`, `status`, `createdBy`, `limit` ≤ 200, `cursor`. |
| GET / PATCH / DELETE | `/v1/links/:code` | read / write / write | Read; edit any subset (`expiresAt`/`maxClicks` accept `null`); delete. |
| GET | `/v1/links/:code/stats` | read | `days` (default 30): totals, unique visitors, bots, per day, referrers, devices, recent. |
| GET | `/v1/links/:code/qr` | read | QR for any link, also disabled ones. |
| GET | `/v1/qr` | read | `text=` → QR image. |
| GET | `/v1/stats` | read | `days` (default 7): link counts, clicks in window, top links. |
| GET | `/metrics` | read | Prometheus text. |

Error codes: `LINK_NOT_FOUND`, `LINK_GONE`, `SLUG_TAKEN`, `SLUG_RESERVED`, `INVALID_URL`, `HOST_BLOCKED`, `INVALID_EXPIRY`, `QR_TOO_LONG`, `INVALID_CURSOR`, `VALIDATION_FAILED`, `UNAUTHORIZED`, `FORBIDDEN`, `RATE_LIMITED`.

### From a backend

```js
const res = await fetch(`${process.env.SHORTLINK_URL}/v1/links`, {
  method: 'POST',
  headers: { authorization: `Bearer ${process.env.SHORTLINK_API_KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify({ url: longUrl, tags: ['invoice'], expiresAt: new Date(Date.now() + 30 * 864e5).toISOString() }),
});
const { link } = await res.json();
// link.shortUrl → put in the SMS; link.qrUrl + '?format=png&scale=6' → put on the PDF
```

## Examples

Scenario walkthroughs for every feature live in [examples/](examples/README.md).

## Configuration

All settings come from environment variables and are validated at startup. See [.env.example](.env.example). Required: `SHORTLINK_API_KEYS`, `PUBLIC_BASE_URL` (public origin of the short domain), `HASH_SECRET` (≥ 32 chars).

Behind a reverse proxy set `TRUST_PROXY=true`; deny `/v1/` and `/metrics` on the public domain if the management API should not be reachable from the internet.

## Security notes

- Destination URLs must be absolute `http(s)`, without credentials, not the service's own host, not in `BLOCKED_HOSTS`. The service never fetches destinations.
- Redirect targets come only from the database; the `Location` header is never built from request input.
- Preview and QR responses carry strict `Content-Security-Policy` (`default-src 'none'`, QR SVG sandboxed); all responses `X-Content-Type-Options: nosniff`; API responses `Cache-Control: no-store`.
- Public side rate limited per address, API per key; keys compared in constant time; unknown fields rejected; bodies capped at `BODY_LIMIT`.
- Visitor addresses are never stored (keyed hash only); referrers are reduced to a host; no cookies.
- Container runs as the unprivileged `node` user.

## Code layout

Class-based; dependencies are injected through constructors, `src/application.js` is the composition root.

| Class | File | Role |
|---|---|---|
| `Application` | `src/application.js` | Wiring, startup, graceful shutdown |
| `Config` | `src/config.js` | Validated environment |
| `Database` | `src/db.js` | SQLite connection, migrations, transactions |
| `LinkStore`, `ClickStore` | `src/store/` | Persistence and aggregates |
| `LinkService`, `Cursor` | `src/domain/link-service.js` | Create, update, list, follow, statistics |
| `Slug`, `Visitor`, `LinkError` | `src/domain/` | Codes and reserved words, visitor hashing and device classes, errors |
| `QrCode`, `PngEncoder` | `src/qr/qr-code.js` | QR encoder (ISO/IEC 18004, level M, v1–10), grayscale PNG writer |
| `ShortlinkApi`, `ApiKeyAuth`, `Schemas`, `Views`, `PreviewPage` | `src/http/` | Fastify routes, roles, shapes, preview HTML |
| `Maintenance` | `src/maintenance.js` | Hourly click-log retention |

## Out of scope by design

- Multiple short domains per instance: `PUBLIC_BASE_URL` is one origin; run another instance for another domain.
- Geolocation of visitors: needs a GeoIP database and stores more than this service wants to; derive it downstream from your proxy logs if you must.
- Password-protected links and link-level access control: put such links behind your application, which then calls this service.
- QR codes above 213 bytes, logos or colours: shorten first, style the SVG downstream.
- Bulk import: loop over `POST /v1/links`; the per-key rate limit (600/min) is the only bound.

## Audit events

With `AUDIT_URL` and `AUDIT_API_KEY` set, every completed write request is forwarded to the audit service as one event (`success`, or `denied` on 403) with the calling key as actor, the affected entity as target, client IP, user agent and request id. Events are buffered and sent in batches; the audit service being down never fails a request. Actions: see [examples/audit-events.md](examples/audit-events.md).

## Scaling model

**B — single-node stateful.** One process owns one SQLite file (`instances: 1`). Every write path, including the public redirect
path, stays consistent across any number of connections or processes sharing that file — `maxClicks`
enforcement is one atomic conditional `UPDATE`
(`clicks = clicks + 1 ... WHERE ... clicks < max_clicks`), not a read-then-decide-then-write, so a
link with `maxClicks = N` can never accumulate more than `N` successful redirects no matter how many
processes are serving it concurrently. This is SQLite's own write serialization doing the work, not
a process-local lock. See [docs/READINESS.md](docs/READINESS.md) for the full contract and the
real cross-connection concurrency tests that prove it.

## Observability

Requests are logged with `reqId` (accepts or generates `X-Request-Id`) and `traceId`/`spanId` (a
trusted inbound `traceparent`, gated on `TRUST_PROXY`, continues the caller's trace with a fresh
span-id for this hop; see [OBSERVABILITY.md](../atc-stack/docs/OBSERVABILITY.md)). `/health` is a static check; `/ready` pings the database, cached for 10s, and
never mutates state. `/metrics` numbers are all live database reads, so they don't reset on restart
or diverge between processes. See [docs/READINESS.md](docs/READINESS.md) for the full contract.

## Backup / restore

The only state to protect is the SQLite file at `DB_PATH` (default `./data/shortlink.db`, plus its
WAL sidecars while running). Use `stack backup`/`stack restore` from the workspace root (see
`atc-stack/docs/UPGRADE.md`) to snapshot and restore this consistently alongside the rest of the stack.
On every start, before applying a pending migration to an existing database, the service itself
also snapshots the file to `DB_PATH.pre-v<N>-<timestamp>` (directory overridable with
`DB_BACKUP_DIR`) — a manual last resort if `stack restore` is unavailable; migrations reapply
automatically on start either way.

**Rollback limitations:** none of the migrations are reversible; to roll back, restore the
pre-migration copy (or a `stack backup` snapshot taken before the upgrade) and run the previous
version of this service against it. See [docs/READINESS.md](docs/READINESS.md) for the full
contract.

## License

MIT, see [LICENSE](LICENSE).
