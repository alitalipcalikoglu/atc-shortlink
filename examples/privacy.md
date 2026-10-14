# Privacy and retention

## What a click stores

| Stored | Not stored |
|---|---|
| time | IP address |
| `visitor`: `HMAC-SHA256(HASH_SECRET, ip + "\n" + user agent)`, first 32 hex chars | user agent string |
| referrer **host** (`instagram.com`) | full referrer URL, query strings |
| device class (`mobile`, `desktop`, `bot`, `other`) | cookies (none are set), geolocation |

The hash lets the statistics count distinct visitors and repeat visits, but nobody can recover an address from the log without `HASH_SECRET`, and the same visitor produces a different hash on every deployment with a different secret. Rotating `HASH_SECRET` resets unique-visitor continuity; it does not affect counts.

Referrers from the service's own host are dropped (the preview page's **Continue** button is `rel="noreferrer"` anyway).

## Retention

`CLICK_RETENTION_DAYS` (default 365): older click data is deleted hourly. Click rows older than `CLICK_RAW_DAYS` (default 30) are first rolled up into one row per link and day (clicks, bots and unique visitors of that day) and the raw rows, with their visitor hashes, referrers and devices, are deleted; so the table stays small and statistics keep working over the full retention window. For the rolled-up part, `visitors` is the sum of the daily unique counts, and referrers and devices cover the raw window only. The `clicks` counter and `lastClickAt` on each link are kept forever, so lifetime totals survive; only per-day series, referrers and devices are bounded.

## Visitors' exposure to destinations

The redirect sends `Referrer-Policy: no-referrer-when-downgrade`, so destinations see the short URL as referrer on HTTPS→HTTPS, nothing on HTTPS→HTTP. The preview page sends none.

## Robots

`/robots.txt` disallows everything: crawlers should not index short URLs or preview pages, and preview pages carry `noindex` as well.
