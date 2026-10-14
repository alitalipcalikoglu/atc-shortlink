# Operations

## Probes

```bash
curl -s $SL/health   # {"status":"ok"}
curl -s $SL/ready    # {"status":"ok"} when SQLite answers; 503 otherwise (cached 10 s)
```

## Metrics

```bash
slcurl $SL/metrics
```

```
shortlink_links{state="active"} 390
shortlink_links{state="inactive"} 22
shortlink_clicks_total 88120
shortlink_clicks_last_hour 412
shortlink_click_rows 1203311
shortlink_process_uptime_seconds 86400
```

## Environment

Required: `SHORTLINK_API_KEYS`, `PUBLIC_BASE_URL`, `HASH_SECRET`. Full list: [.env.example](../.env.example).

`PUBLIC_BASE_URL` is what visitors type and what QR codes contain: the public origin (`https://s.example.com`), not the internal address.

## Reverse proxy

The public side is meant to sit on its own short domain. With nginx:

```nginx
server {
  server_name s.example.com;
  location / { proxy_pass http://10.0.0.6:3006; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header Host $host; }
  location /v1/ { deny all; }        # management API stays internal
  location /metrics { deny all; }
  error_page 404 410 /gone.html;    # optional branded page
}
```

Set `TRUST_PROXY=true`. Alternatively route through the gateway and give the gateway a `write` key; keep redirects on the short domain for speed.

## Process manager

```bash
cp .env.example .env && $EDITOR .env
npm ci --omit=dev
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
pm2 reload shortlink
```

`kill_timeout` is 35 s; SIGTERM stops accepting connections, finishes in-flight requests, closes the database.

## Docker

```bash
docker build -t atc-shortlink .
docker run -d -p 3006:3006 -v atc-shortlink-data:/data --env-file .env atc-shortlink
```

## Logs

JSON lines. `Authorization` is redacted. Redirects log at `info`; QR and preview requests only at `warn` and above to keep noise down. `retention purge removed click rows` (info) reports how many rows went.

## Backups

```bash
sqlite3 data/shortlink.db ".backup 'shortlink-$(date +%F).db'"
```

Losing `HASH_SECRET` does not lose data; unique-visitor counts simply restart.
