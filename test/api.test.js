import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Maintenance } from '../src/maintenance.js';
import { BASE, READ_KEY, RW_KEY, WRITE_KEY, bearer, buildApp } from './helpers.js';

const json = (/** @type {import('light-my-request').Response} */ r) => JSON.parse(r.body);
const UA = { 'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/130' };
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

test('API: probes, auth, roles, robots', async (t) => {
  const { app } = await buildApp();
  t.after(() => app.close());
  assert.equal((await app.inject({ url: '/health' })).statusCode, 200);
  assert.equal((await app.inject({ url: '/ready' })).statusCode, 200);
  const spec = await app.inject({ url: '/openapi.yaml' });
  assert.equal(spec.body, readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8'));
  assert.match(String(spec.headers['content-type']), /^text\/yaml/);
  assert.match((await app.inject({ url: '/robots.txt' })).body, /Disallow: \//);
  assert.equal((await app.inject({ url: '/v1/links' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/v1/links', headers: bearer(WRITE_KEY) })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/links', headers: bearer(READ_KEY), payload: { url: 'https://example.com' } })).statusCode, 403);
  assert.equal((await app.inject({ url: '/metrics', headers: bearer(WRITE_KEY) })).statusCode, 403);
  const nf = await app.inject({ url: '/nope', headers: UA });
  assert.equal(nf.statusCode, 404);
  assert.equal(json(nf).error.code, 'LINK_NOT_FOUND');
  assert.equal((await app.inject({ url: '/x' })).statusCode, 404, 'too short for a code');
  assert.equal((await app.inject({ url: '/health' })).headers['x-content-type-options'], 'nosniff');
});

test('API: /v1/info', async (t) => {
  const { app } = await buildApp();
  t.after(() => app.close());
  const info = json(await app.inject({ url: '/v1/info' }));
  assert.equal(info.service, 'atc-shortlink');
  assert.equal(info.version, PACKAGE_VERSION);
  assert.equal(info.apiVersion, 'v1');
  assert.deepEqual(info.capabilities, ['qr-codes', 'click-limits']);
  assert.equal(typeof info.schemaVersion, 'number');
  assert.equal(typeof info.serviceCore, 'string');
});

test('API: create, redirect, preview, head, gone states, delete', async (t) => {
  const { app } = await buildApp();
  t.after(() => app.close());
  let res = await app.inject({ method: 'POST', url: '/v1/links', headers: bearer(WRITE_KEY), payload: { url: 'https://example.com/landing?utm=x', slug: 'promo', tags: ['Spring'], note: 'poster' } });
  assert.equal(res.statusCode, 201, res.body);
  const { link } = json(res);
  assert.equal(res.headers.location, '/v1/links/promo');
  assert.equal(link.shortUrl, `${BASE}/promo`);
  assert.equal(link.previewUrl, `${BASE}/promo+`);
  assert.equal(link.qrUrl, `${BASE}/promo/qr`);
  assert.equal(link.status, 'active');
  assert.equal(link.createdBy, 'worker');
  assert.deepEqual(link.tags, ['spring']);
  assert.equal(link.remainingClicks, null);

  res = await app.inject({ url: '/promo', headers: { ...UA, referer: 'https://twitter.com/x' } });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, 'https://example.com/landing?utm=x');
  assert.equal(res.headers['cache-control'], 'private, max-age=0, no-cache');
  assert.equal((await app.inject({ method: 'HEAD', url: '/promo', headers: UA })).statusCode, 302);
  res = await app.inject({ url: '/promo+' });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /text\/html/);
  assert.match(res.body, /https:\/\/example\.com\/landing\?utm=x/);
  assert.match(res.body, /Continue to example\.com/);
  assert.match(String(res.headers['content-security-policy']), /default-src 'none'/);
  assert.equal((await app.inject({ url: '/v1/links/promo', headers: bearer(READ_KEY) })).json().link.clicks, 2);

  res = await app.inject({ method: 'PATCH', url: '/v1/links/promo', headers: bearer(RW_KEY), payload: { permanent: true } });
  assert.equal(json(res).link.permanent, true);
  res = await app.inject({ url: '/promo', headers: UA });
  assert.equal(res.statusCode, 301);
  assert.equal(res.headers['cache-control'], 'public, max-age=300');

  res = await app.inject({ method: 'PATCH', url: '/v1/links/promo', headers: bearer(RW_KEY), payload: { enabled: false } });
  assert.equal(json(res).link.status, 'disabled');
  res = await app.inject({ url: '/promo', headers: UA });
  assert.equal(res.statusCode, 410);
  assert.equal(json(res).error.code, 'LINK_GONE');
  res = await app.inject({ url: '/promo+' });
  assert.match(res.body, /This link is disabled/);
  assert.equal((await app.inject({ url: '/promo/qr' })).statusCode, 410);

  assert.equal((await app.inject({ method: 'DELETE', url: '/v1/links/promo', headers: bearer(RW_KEY) })).statusCode, 204);
  assert.equal((await app.inject({ url: '/promo', headers: UA })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: '/v1/links/promo', headers: bearer(RW_KEY) })).statusCode, 404);
});

test('API: validation errors', async (t) => {
  const { app } = await buildApp({ BLOCKED_HOSTS: 'evil.test' });
  t.after(() => app.close());
  const post = (/** @type {object} */ payload) => app.inject({ method: 'POST', url: '/v1/links', headers: bearer(RW_KEY), payload });
  let r = await post({});
  assert.equal(json(r).error.code, 'VALIDATION_FAILED');
  r = await post({ url: 'https://example.com', slug: 'a' });
  assert.equal(json(r).error.code, 'VALIDATION_FAILED');
  r = await post({ url: 'https://example.com', extra: 1 });
  assert.equal(r.statusCode, 400);
  r = await post({ url: 'ftp://example.com' });
  assert.equal(json(r).error.code, 'INVALID_URL');
  r = await post({ url: 'https://evil.test/x' });
  assert.equal(json(r).error.code, 'HOST_BLOCKED');
  r = await post({ url: 'https://example.com', slug: 'metrics' });
  assert.equal(json(r).error.code, 'SLUG_RESERVED');
  await post({ url: 'https://example.com', slug: 'taken' });
  r = await post({ url: 'https://example.com', slug: 'taken' });
  assert.equal(r.statusCode, 409);
  r = await post({ url: 'https://example.com', expiresAt: '2000-01-01T00:00:00Z' });
  assert.equal(json(r).error.code, 'INVALID_EXPIRY');
  r = await app.inject({ method: 'PATCH', url: '/v1/links/taken', headers: bearer(RW_KEY), payload: {} });
  assert.equal(r.statusCode, 400);
  r = await app.inject({ url: '/v1/links?limit=999', headers: bearer(RW_KEY) });
  assert.equal(r.statusCode, 400);
  r = await app.inject({ url: '/v1/links?cursor=!!', headers: bearer(RW_KEY) });
  assert.equal(json(r).error.code, 'INVALID_CURSOR');
});

test('API: list with filters and cursor, stats, overview, metrics', async (t) => {
  const { app } = await buildApp();
  t.after(() => app.close());
  for (let i = 0; i < 4; i++) await app.inject({ method: 'POST', url: '/v1/links', headers: bearer(RW_KEY), payload: { url: `https://example.com/${i}`, slug: `l${i}abc`, tags: i % 2 ? ['odd'] : [] } });
  await app.inject({ url: '/l0abc', headers: UA });
  await app.inject({ url: '/l0abc', headers: { ...UA, referer: 'https://a.example/' } });
  await app.inject({ url: '/l0abc', headers: { 'user-agent': 'Slackbot 1.0' } });
  const list = (/** @type {string} */ qs) => app.inject({ url: `/v1/links?${qs}`, headers: bearer(READ_KEY) }).then(json);
  let page = await list('limit=3');
  assert.equal(page.items.length, 3);
  assert.ok(page.nextCursor);
  page = await list(`limit=3&cursor=${page.nextCursor}`);
  assert.equal(page.items.length, 1);
  assert.equal(page.nextCursor, null);
  assert.equal((await list('tag=odd')).items.length, 2);
  assert.equal((await list('q=example.com/2')).items.length, 1);
  assert.equal((await list('status=active')).items.length, 4);

  const st = json(await app.inject({ url: '/v1/links/l0abc/stats?days=7', headers: bearer(READ_KEY) }));
  assert.equal(st.total, 2);
  assert.equal(st.clicks, 3);
  assert.equal(st.bots, 1);
  assert.equal(st.visitors, 1, 'same address+agent counted once, bots excluded');
  assert.deepEqual(st.byReferrer.map((/** @type {any} */ r) => r.referrer).sort(), [null, 'a.example'].sort());
  assert.equal(st.recent.length, 3);
  assert.match(st.since, /^\d{4}-/);
  assert.equal(st.recent[0].visitor.length, 32);

  const o = json(await app.inject({ url: '/v1/stats', headers: bearer(READ_KEY) }));
  assert.deepEqual(o.links, { total: 4, active: 4, clicks: 2 });
  assert.equal(o.topLinks[0].shortUrl, `${BASE}/l0abc`);

  const m = await app.inject({ url: '/metrics', headers: bearer(READ_KEY) });
  assert.match(m.body, /shortlink_links\{state="active"\} 4/);
  assert.match(m.body, /shortlink_clicks_total 2/);
  assert.match(m.body, /shortlink_click_rows 3/);
});

test('API: QR endpoints, formats, ETag, limits', async (t) => {
  const { app } = await buildApp();
  t.after(() => app.close());
  await app.inject({ method: 'POST', url: '/v1/links', headers: bearer(RW_KEY), payload: { url: 'https://example.com', slug: 'qrme' } });
  let res = await app.inject({ url: '/qrme/qr' });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /image\/svg\+xml/);
  assert.equal(res.headers['cache-control'], 'public, max-age=86400');
  assert.match(String(res.headers['content-security-policy']), /sandbox/);
  const etag = String(res.headers.etag);
  assert.match(etag, /^"[A-Za-z0-9_-]+"$/);
  assert.equal((await app.inject({ url: '/qrme/qr', headers: { 'if-none-match': etag } })).statusCode, 304);
  res = await app.inject({ url: '/qrme/qr?format=png&scale=4&margin=2' });
  assert.match(String(res.headers['content-type']), /image\/png/);
  assert.equal(res.rawPayload[0], 0x89);
  assert.notEqual(res.headers.etag, etag);
  assert.equal((await app.inject({ url: '/qrme/qr?scale=99' })).statusCode, 400);
  res = await app.inject({ url: '/v1/links/qrme/qr?format=png', headers: bearer(READ_KEY) });
  assert.equal(res.statusCode, 200);
  res = await app.inject({ url: `/v1/qr?text=${encodeURIComponent('WIFI:T:WPA;S:net;P:pw;;')}`, headers: bearer(READ_KEY) });
  assert.equal(res.statusCode, 200);
  res = await app.inject({ url: `/v1/qr?text=${'x'.repeat(300)}`, headers: bearer(READ_KEY) });
  assert.equal(res.statusCode, 400);
  assert.equal(json(res).error.code, 'QR_TOO_LONG');
  assert.equal((await app.inject({ url: '/v1/qr?text=x' })).statusCode, 401, 'generic QR needs a key');
  assert.equal((await app.inject({ url: '/nope999/qr' })).statusCode, 404);
});

test('API: rate limits per key and per address', async (t) => {
  const { app } = await buildApp({ RATE_LIMIT_MAX: '2', REDIRECT_RATE_LIMIT_MAX: '2' });
  t.after(() => app.close());
  await app.inject({ method: 'POST', url: '/v1/links', headers: bearer(RW_KEY), payload: { url: 'https://example.com', slug: 'rl-test' } });
  await app.inject({ url: '/v1/stats', headers: bearer(RW_KEY) });
  const limited = await app.inject({ url: '/v1/stats', headers: bearer(RW_KEY) });
  assert.equal(limited.statusCode, 429);
  assert.equal(json(limited).error.code, 'RATE_LIMITED');
  assert.equal((await app.inject({ url: '/v1/stats', headers: bearer(READ_KEY) })).statusCode, 200, 'other key unaffected');
  await app.inject({ url: '/rl-test', headers: UA, remoteAddress: '10.0.0.1' });
  await app.inject({ url: '/rl-test', headers: UA, remoteAddress: '10.0.0.1' });
  assert.equal((await app.inject({ url: '/rl-test', headers: UA, remoteAddress: '10.0.0.1' })).statusCode, 429);
  assert.equal((await app.inject({ url: '/rl-test', headers: UA, remoteAddress: '10.0.0.2' })).statusCode, 302, 'other address unaffected');
});

test('Maintenance: purges old click rows only', async (t) => {
  const { app, clicks, links } = await buildApp();
  t.after(() => app.close());
  await app.inject({ method: 'POST', url: '/v1/links', headers: bearer(RW_KEY), payload: { url: 'https://example.com', slug: 'old-one' } });
  const day = 86_400_000;
  const now = Date.now();
  clicks.record({ code: 'old-one', at: now - 400 * day, visitor: 'v', referrer: null, device: 'desktop' });
  clicks.record({ code: 'old-one', at: now - 1 * day, visitor: 'v', referrer: null, device: 'desktop' });
  const m = new Maintenance({ clicks, log: /** @type {any} */ ({ info() {}, error() {} }), options: { clickRetentionDays: 365, clickRawDays: 30 } });
  assert.equal(m.run(now), 1);
  assert.equal(clicks.count(), 1);
  assert.ok(links.byCode('old-one'));
  m.start(); m.stop();
  assert.equal(m.timer, null);
});

test('clicks: rows are buffered and flushed together; stats and reads see them at once; the counter is exact either way', async (t) => {
  const { app, clicks, links } = await buildApp();
  t.after(() => app.close());
  await app.inject({ method: 'POST', url: '/v1/links', headers: bearer(RW_KEY), payload: { url: 'https://example.com', slug: 'buffered', maxClicks: 3 } });
  const follow = () => app.inject({ url: '/buffered', headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux) Chrome/120' } });
  for (let i = 0; i < 3; i += 1) assert.equal((await follow()).statusCode, 302);
  assert.equal(clicks.buffer.length, 3, 'nothing written yet, the redirects only touched the counter');
  assert.equal((await follow()).statusCode, 410, 'maxClicks is exact without the click log');
  assert.equal(links.byCode('buffered')?.clicks, 3);
  const stats = JSON.parse((await app.inject({ url: '/v1/links/buffered/stats', headers: bearer(RW_KEY) })).body);
  assert.deepEqual([stats.clicks, clicks.buffer.length], [3, 0], 'reading flushes');
  clicks.record({ code: 'deleted-meanwhile', at: Date.now(), visitor: 'v', referrer: null, device: 'desktop' });
  assert.equal(clicks.flush(), 1);
  assert.equal(clicks.count(), 3, 'a row of a link that is gone is dropped, not an error');
  for (let i = 0; i < 500; i += 1) clicks.record({ code: 'buffered', at: Date.now(), visitor: `v${i}`, referrer: null, device: 'desktop' });
  assert.equal(clicks.buffer.length, 0, 'a full buffer flushes itself');
});

test('click roll-up: rows older than the raw window become one row per link and day; stats still add up; retention drops old days', async (t) => {
  const { app, clicks } = await buildApp();
  t.after(() => app.close());
  await app.inject({ method: 'POST', url: '/v1/links', headers: bearer(RW_KEY), payload: { url: 'https://example.com', slug: 'rolled' } });
  const day = 86_400_000;
  const base = Math.floor(Date.now() / day) * day;
  const add = (/** @type {number} */ daysAgo, /** @type {string} */ visitor, /** @type {'desktop'|'bot'} */ device = 'desktop') => clicks.record({ code: 'rolled', at: base - daysAgo * day + 1_000, visitor, referrer: null, device });
  add(40, 'a'); add(40, 'a'); add(40, 'b'); add(40, 'bot1', 'bot'); add(39, 'a'); add(2, 'c');
  const m = new Maintenance({ clicks, log: /** @type {any} */ ({ info() {}, error() {} }), options: { clickRetentionDays: 365, clickRawDays: 30 } });
  m.run(base + 5_000);
  assert.equal(clicks.count(), 1, 'only the recent raw row is left');
  const stats = JSON.parse((await app.inject({ url: '/v1/links/rolled/stats?days=60', headers: bearer(RW_KEY) })).body);
  assert.deepEqual([stats.clicks, stats.bots, stats.byDay.map((/** @type {any} */ d) => [d.clicks, d.visitors])], [6, 1, [[3, 2], [1, 1], [1, 1]]], 'totals include the rolled-up days; the day list is complete');
  m.run(base + 5_000); // nothing left to roll up
  assert.equal(JSON.parse((await app.inject({ url: '/v1/links/rolled/stats?days=60', headers: bearer(RW_KEY) })).body).clicks, 6);
  const later = new Maintenance({ clicks, log: /** @type {any} */ ({ info() {}, error() {} }), options: { clickRetentionDays: 10, clickRawDays: 5 } });
  later.run(base + 5_000);
  assert.equal(JSON.parse((await app.inject({ url: '/v1/links/rolled/stats?days=60', headers: bearer(RW_KEY) })).body).clicks, 1, 'days past the retention are gone');
});
