import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config, ConfigError } from '../src/config.js';
import { testEnv } from './helpers.js';

test('Config: defaults, roles, public host', () => {
  const c = Config.fromEnv(testEnv());
  assert.equal(c.port, 0);
  assert.equal(c.codeLength, 7);
  assert.equal(c.publicBaseUrl, 'https://s.test');
  assert.equal(c.publicHost, 's.test');
  assert.deepEqual(c.apiKeys.map((k) => [k.id, k.role]), [['shop', 'readwrite'], ['console', 'read'], ['worker', 'write']]);
  assert.deepEqual(Config.fromEnv(testEnv({ BLOCKED_HOSTS: 'Evil.example, bad.test' })).blockedHosts, ['evil.example', 'bad.test']);
  assert.ok(Object.isFrozen(c));
});

test('Config: rejects bad input', () => {
  const bad = (/** @type {Record<string,string>} */ o, /** @type {RegExp} */ re) => assert.throws(() => Config.fromEnv(testEnv(o)), (e) => e instanceof ConfigError && re.test(e.message));
  bad({ SHORTLINK_API_KEYS: '' }, /SHORTLINK_API_KEYS is required/);
  bad({ SHORTLINK_API_KEYS: 'shop:short' }, /at least 32/);
  bad({ SHORTLINK_API_KEYS: `a:${'a'.repeat(40)}:admin` }, /read, write or readwrite/);
  bad({ PUBLIC_BASE_URL: 'https://s.test/path' }, /bare origin/);
  bad({ PUBLIC_BASE_URL: 'ftp://s.test' }, /bare origin/);
  bad({ HASH_SECRET: 'short' }, /HASH_SECRET must be at least 32/);
  bad({ CODE_LENGTH: '3' }, /must be >= 4/);
  bad({ TLS_CERT_PATH: '/x.pem' }, /must be set together/);
});

test('Config: PERMANENT_CACHE_SEC defaults to 5 minutes and accepts 0', () => {
  assert.equal(Config.fromEnv(testEnv()).permanentCacheSec, 300);
  assert.equal(Config.fromEnv(testEnv({ PERMANENT_CACHE_SEC: '0' })).permanentCacheSec, 0);
});
