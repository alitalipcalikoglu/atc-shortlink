# shortlink examples

Scenario-driven walkthroughs of every feature. Requests to `/v1/*` need `Authorization: Bearer <secret>` from `SHORTLINK_API_KEYS`; the public side (`/<code>`, `/<code>+`, `/<code>/qr`) needs nothing. Base URL below is `http://localhost:3006`, `PUBLIC_BASE_URL` is assumed to be the same.

| Example | Shows |
|---|---|
| [Creating links](creating-links.md) | Random codes, custom slugs, tags and notes, what the response contains |
| [Redirects and the preview page](redirects.md) | 302 vs 301, `HEAD`, the `+` preview, what a visitor sees when a link is gone |
| [Expiry and click limits](expiry-and-limits.md) | Time-limited and single-use links, disabling, statuses, what bots count for |
| [QR codes](qr-codes.md) | SVG and PNG for a link or for any text, sizes, caching, printing |
| [Click statistics](statistics.md) | Per-link stats, unique visitors, referrers, devices, service-wide overview |
| [Listing and search](listing.md) | Filters, tags, status, pagination |
| [API keys and roles](keys-and-roles.md) | Read, write, readwrite keys; rate limits |
| [Privacy and retention](privacy.md) | What is stored about visitors, hashing, click retention |
| [Click recording and roll-up](click-recording.md) | Buffered click rows, the exact counter, daily roll-up of old clicks |
| [Operations](operations.md) | Health, readiness, metrics, environment, PM2, Docker, reverse proxy |
| [Audit events](audit-events.md) | Which write actions are forwarded to the audit service, event shape, configuration |

Set up once for the examples:

```bash
export SL=http://localhost:3006
export KEY=<a secret from SHORTLINK_API_KEYS>
alias slcurl='curl -s -H "Authorization: Bearer $KEY" -H "Content-Type: application/json"'
```
