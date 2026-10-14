import { readServiceVersion } from '@atc-web/atc-service-core/fastify';
import { Config } from '../src/config.js';
import { Database } from '../src/db.js';
import { LinkService } from '../src/domain/link-service.js';
import { Visitor } from '../src/domain/visitor.js';
import { ShortlinkApi } from '../src/http/shortlink-api.js';
import { ClickStore } from '../src/store/click-store.js';
import { LinkStore } from '../src/store/link-store.js';

export const RW_KEY = 'k'.repeat(40);
export const READ_KEY = 'r'.repeat(40);
export const WRITE_KEY = 'w'.repeat(40);
export const BASE = 'https://s.test';

/** @param {Record<string, string>} [overrides] */
export function testEnv(overrides = {}) {
  return {
    PORT: '0',
    SHORTLINK_API_KEYS: `shop:${RW_KEY},console:${READ_KEY}:read,worker:${WRITE_KEY}:write`,
    PUBLIC_BASE_URL: BASE,
    HASH_SECRET: 'h'.repeat(40),
    DB_PATH: ':memory:',
    LOG_LEVEL: 'silent',
    ...overrides,
  };
}

/** @param {Record<string, string>} [overrides] */
export function testConfig(overrides) {
  return Config.fromEnv(testEnv(overrides));
}

/** Wired domain objects over an in-memory database. @param {Record<string, string>} [overrides] */
export function testService(overrides) {
  const config = testConfig(overrides);
  const db = new Database(':memory:');
  const links = new LinkStore(db);
  const clicks = new ClickStore(db);
  const service = new LinkService({
    db, links, clicks, visitor: new Visitor(config.hashSecret),
    options: { codeLength: config.codeLength, publicHost: config.publicHost, blockedHosts: config.blockedHosts, maxUrlLength: config.maxUrlLength, defaultPermanent: config.defaultPermanent },
  });
  return { config, db, links, clicks, service };
}

/** Fully wired Fastify app. @param {Record<string, string>} [overrides] @param {object} [deps] Extra constructor deps, e.g. an AuditClient. */
export async function buildApp(overrides, deps = {}) {
  const t = testService(overrides);
  const app = await new ShortlinkApi({ ...t, version: readServiceVersion(import.meta.url), ...deps }).build();
  await app.ready();
  return { app, ...t };
}

/** @param {string} key */
export function bearer(key) {
  return { authorization: `Bearer ${key}` };
}
