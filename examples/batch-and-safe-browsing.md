# Bulk import and unsafe URLs

## Create many links at once

`POST /v1/links/batch` takes 1-500 items shaped exactly like `POST /v1/links` and needs the `write` role. Items are independent: one bad item never stops the others.

```bash
curl -X POST "$SL/v1/links/batch" -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{
  "links": [
    { "url": "https://shop.example/spring", "slug": "spring", "tags": ["campaign"] },
    { "url": "https://shop.example/summer", "slug": "spring" },
    { "url": "ftp://files.example/old" },
    { "url": "https://shop.example/autumn" }
  ]
}'
```

```json
{
  "created": 2,
  "failed": 2,
  "results": [
    { "index": 0, "link": { "code": "spring", "shortUrl": "http://localhost:3006/spring", "url": "https://shop.example/spring", "…": "…" } },
    { "index": 1, "error": { "code": "SLUG_TAKEN", "message": "\"spring\" is already in use" } },
    { "index": 2, "error": { "code": "INVALID_URL", "message": "url must use http or https" } },
    { "index": 3, "link": { "code": "aZ81kQx", "…": "…" } }
  ]
}
```

The status is `200` even when some items fail; read `failed` and the `error` entries. `index` is the item's position in the request, so a script can retry only the failed ones. The whole batch is refused with `400 VALIDATION_FAILED` only when it is empty, has more than 500 items or an item breaks the schema (unknown field, wrong type). The body may be up to 2 MiB, larger than `BODY_LIMIT`.

The audit service gets one `atc-shortlink.link.batch` event per call with `{ created, failed, codes }`.

## Refuse phishing and malware destinations

Set a Google Safe Browsing API key (Lookup API v4, enabled in a Google Cloud project):

```
SAFE_BROWSING_API_KEY=AIza…
SAFE_BROWSING_TIMEOUT_MS=3000
```

Every new destination (`POST /v1/links`, each item of a batch) and every changed one (`PATCH` with `url`) is checked against the malware, social engineering and unwanted software lists. A listed URL is refused:

```json
{ "error": { "code": "URL_UNSAFE", "message": "url is listed by Safe Browsing (SOCIAL_ENGINEERING)", "details": { "threat": "SOCIAL_ENGINEERING" } } }
```

In a batch the same code appears in that item's `error`; a batch costs one lookup.

## Pitfalls

- Fail-open by design: when Google cannot be reached within the timeout, or answers with an error, the URL is accepted and a `safe browsing check failed` warning is logged. Watch `shortlink_safe_browsing_failures_total` in `/metrics`. `BLOCKED_HOSTS` remains the hard local block list.
- The check runs at creation and change only. A link created before a site was listed keeps working; disable it with `PATCH { "enabled": false }`.
- Destination URLs are sent to Google. Leave the key empty if that is not acceptable for your data.
- Rate limit: a batch is one request against the per-key limit, but 500 inserts take a moment; keep batches below a few hundred when other traffic is latency sensitive.
