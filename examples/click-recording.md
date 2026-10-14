# Click recording and roll-up

A redirect does exactly one small write: the link's own counter (`clicks`, `lastClickAt`) is incremented in one atomic conditional statement. That counter is exact and is what enforces `maxClicks`: concurrent visitors can never exceed the limit.

The detailed click row (time, visitor hash, referrer host, device) is detail data. It goes into an in-memory buffer and is written together with its neighbours in a single transaction:

- every `CLICK_FLUSH_MS` (default 1000 ms),
- when 500 rows are waiting,
- before any read (statistics, recent clicks, metrics), so a statistics call always includes the clicks that just happened,
- on graceful shutdown.

A crash loses at most the unflushed rows (about a second of detail), never a count. Rows of a link deleted in the meantime are dropped silently.

## Roll-up

Once an hour rows older than `CLICK_RAW_DAYS` (default 30), counted in whole days, are aggregated into one row per link and day (`clicks`, `bots`, unique `visitors` of that day) and deleted. `GET /v1/links/:code/stats?days=90` then adds the rolled-up days to the raw ones:

```json
{ "clicks": 1840, "visitors": 902, "bots": 61,
  "byDay": [ { "day": "2026-08-20", "clicks": 40, "visitors": 31 }, "..." ],
  "byReferrer": [ "...raw window only..." ], "byDevice": { "...": "raw window only" } }
```

Pitfalls:
- `visitors` across rolled-up days is the sum of daily uniques (a person who came on three days counts three times); inside the raw window it is the exact distinct count.
- Referrers and devices of rolled-up days are not kept. Raise `CLICK_RAW_DAYS` if you need them for longer, at the cost of a bigger table.
- `CLICK_RAW_DAYS` may not exceed `CLICK_RETENTION_DAYS`; days older than the retention are deleted.
