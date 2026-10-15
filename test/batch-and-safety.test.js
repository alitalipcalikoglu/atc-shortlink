import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UrlReputation } from '../src/domain/url-reputation.js';
import { RW_KEY, READ_KEY, bearer, buildApp, testConfig } from './helpers.js';

const quiet = { warn: () => {} };

/** Fake Safe Browsing endpoint: flags every URL containing "evil". @param {{ fail?: boolean, calls?: any[] }} [o] */
function fakeFetch(o = {}) {
  return /** @type {typeof fetch} */ (async (url, init) => {
    o.calls?.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    if (o.fail) throw new Error('network down');
    const entries = JSON.parse(String(init?.body)).threatInfo.threatEntries;
    const matches = entries.filter((/** @type {{ url: string }} */ e) => e.url.includes('evil')).map((/** @type {{ url: string }} */ e) => ({ threatType: 'SOCIAL_ENGINEERING', threat: { url: e.url } }));
    return new Response(JSON.stringify(matches.length ? { matches } : {}), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

test('config: SAFE_BROWSING_API_KEY is optional', () => {
  assert.equal(testConfig().safeBrowsingApiKey, null);
  const c = testConfig({ SAFE_BROWSING_API_KEY: 'abc', SAFE_BROWSING_TIMEOUT_MS: '1500' });
  assert.equal(c.safeBrowsingApiKey, 'abc');
  assert.equal(c.safeBrowsingTimeoutMs, 1500);
});

test('Safe Browsing: flagged URLs are refused on create and update, one lookup per request', async () => {
  const { app, service } = await buildApp();
  const calls = /** @type {any[]} */ ([]);
  service.reputation = new UrlReputation({ apiKey: 'k&1', timeoutMs: 1000, log: quiet, fetch: fakeFetch({ calls }) });
  const bad = await app.inject({ method: 'POST', url: '/v1/links', headers: bearer(RW_KEY), payload: { url: 'https://evil.example/login' } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.code, 'URL_UNSAFE');
  assert.match(calls[0].url, /key=k%261$/);
  const ok = await app.inject({ method: 'POST', url: '/v1/links', headers: bearer(RW_KEY), payload: { url: 'https://good.example/' } });
  assert.equal(ok.statusCode, 201);
  const code = ok.json().link.code;
  const patch = await app.inject({ method: 'PATCH', url: `/v1/links/${code}`, headers: bearer(RW_KEY), payload: { url: 'https://evil.example/x' } });
  assert.equal(patch.json().error.code, 'URL_UNSAFE');
  assert.equal((await app.inject({ method: 'PATCH', url: `/v1/links/${code}`, headers: bearer(RW_KEY), payload: { note: 'n' } })).statusCode, 200);
  assert.equal(calls.length, 3, 'a patch without url does not call the API');
  assert.match((await app.inject({ url: '/metrics', headers: bearer(RW_KEY) })).body, /shortlink_safe_browsing_flagged_total 2/);
  await app.close();
});

test('Safe Browsing is fail-open: an unreachable API never blocks creation', async () => {
  const { app, service } = await buildApp();
  service.reputation = new UrlReputation({ apiKey: 'k', timeoutMs: 1000, log: quiet, fetch: fakeFetch({ fail: true }) });
  const res = await app.inject({ method: 'POST', url: '/v1/links', headers: bearer(RW_KEY), payload: { url: 'https://evil.example/' } });
  assert.equal(res.statusCode, 201);
  assert.equal(service.reputation.failures, 1);
  await app.close();
});

test('POST /v1/links/batch: per-item results, one Safe Browsing lookup, write role', async () => {
  const { app, service } = await buildApp();
  const calls = /** @type {any[]} */ ([]);
  service.reputation = new UrlReputation({ apiKey: 'k', timeoutMs: 1000, log: quiet, fetch: fakeFetch({ calls }) });
  const links = [
    { url: 'https://a.example/', slug: 'batch-a', tags: ['import'] },
    { url: 'https://evil.example/' },
    { url: 'ftp://nope.example/' },
    { url: 'https://b.example/', slug: 'batch-a' },
    { url: 'https://c.example/' },
  ];
  const res = await app.inject({ method: 'POST', url: '/v1/links/batch', headers: bearer(RW_KEY), payload: { links } });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.created, 2);
  assert.equal(body.failed, 3);
  assert.deepEqual(body.results.map((/** @type {any} */ r) => r.link?.code ?? r.error.code), ['batch-a', 'URL_UNSAFE', 'INVALID_URL', 'SLUG_TAKEN', body.results[4].link.code]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.threatInfo.threatEntries.length, 5);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/links/batch', headers: bearer(READ_KEY), payload: { links } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/links/batch', headers: bearer(RW_KEY), payload: { links: [] } })).statusCode, 400);
  const many = Array.from({ length: 501 }, (_, i) => ({ url: `https://x.example/${i}` }));
  assert.equal((await app.inject({ method: 'POST', url: '/v1/links/batch', headers: bearer(RW_KEY), payload: { links: many } })).statusCode, 400);
  const big = Array.from({ length: 300 }, (_, i) => ({ url: `https://x.example/${'p'.repeat(100)}/${i}` }));
  const bigRes = await app.inject({ method: 'POST', url: '/v1/links/batch', headers: bearer(RW_KEY), payload: { links: big } });
  assert.equal(bigRes.json().created, 300, 'larger than BODY_LIMIT is fine on the batch route');
  await app.close();
});
