# Redirects and the preview page

## Following a link

```bash
curl -sI $SL/spring
```

```
HTTP/1.1 302 Found
location: https://example.com/spring-sale
cache-control: private, max-age=0, no-cache
referrer-policy: no-referrer-when-downgrade
```

`302` links are re-resolved on every visit, so edits and disabling take effect immediately and every visit is counted. `permanent: true` links answer `301` with `cache-control: public, max-age=300` (`PERMANENT_CACHE_SEC`, default 5 minutes; `0` sends `no-cache`): faster for visitors, but browsers and CDNs stop asking the service for that long, so counts under-report and edits, disabling and expiry reach cached visitors only after it.

`HEAD` behaves like `GET` (same status and `Location`) and is counted like a visit; link checkers usually identify themselves as bots and are separated in the statistics.

Query strings on the short URL are ignored: `/spring?x=1` redirects to the stored destination unchanged.

## When a link cannot be followed

| Situation | Response |
|---|---|
| Unknown code, or a path that is not a code | `404 { "error": { "code": "LINK_NOT_FOUND" } }` |
| Disabled, expired or click limit reached | `410 Gone { "error": { "code": "LINK_GONE", "details": { "status": "expired" } } }` |
| Too many requests from one address | `429 RATE_LIMITED` (`REDIRECT_RATE_LIMIT_MAX` per minute) |

Put a friendly page in front of these at your reverse proxy if you want branding (`error_page 404 410 /gone.html` in nginx).

## Preview: `/<code>+`

Append `+` to any short URL to see where it goes without going there:

```bash
curl -s $SL/spring+
```

A small self-contained HTML page (no scripts, strict CSP, `noindex`) shows the destination, creation and expiry dates, a QR code, and a **Continue** button. For gone links it says why. Preview views are not counted as clicks. This is the same convention several public shorteners use, so people who know it will try it; it also gives support staff a safe way to inspect a link from a ticket.

## Behind a proxy

Set `TRUST_PROXY=true` when nginx or the gateway sits in front, otherwise every visitor appears to come from the proxy's address: statistics collapse to one visitor and the per-address rate limit hits everyone at once.
