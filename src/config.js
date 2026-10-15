import { ConfigError, EnvReader, parseApiKeys, parseAudit } from '@atc-web/atc-service-core/config';

/** @typedef {import('./types.js').ApiKey} ApiKey */
/** @typedef {import('./types.js').KeyRole} KeyRole */

export { ConfigError };

/** Validated service configuration. Build with {@link Config.fromEnv}. */
export class Config {
  static MIN_SECRET_LENGTH = 32;

  /** @param {import('./types.js').ConfigValues} v */
  constructor(v) {
    this.port = v.port;
    this.host = v.host;
    this.logLevel = v.logLevel;
    this.trustProxy = v.trustProxy;
    this.tls = v.tls;
    this.audit = v.audit;
    this.bodyLimit = v.bodyLimit;
    this.dbPath = v.dbPath;
    this.dbBackupDir = v.dbBackupDir;
    this.apiKeys = v.apiKeys;
    this.rateLimitMax = v.rateLimitMax;
    this.redirectRateLimitMax = v.redirectRateLimitMax;
    this.permanentCacheSec = v.permanentCacheSec;
    this.publicBaseUrl = v.publicBaseUrl;
    this.codeLength = v.codeLength;
    this.hashSecret = v.hashSecret;
    this.clickRetentionDays = v.clickRetentionDays;
    this.clickRawDays = v.clickRawDays;
    this.clickFlushMs = v.clickFlushMs;
    this.blockedHosts = v.blockedHosts;
    this.safeBrowsingApiKey = v.safeBrowsingApiKey;
    this.safeBrowsingTimeoutMs = v.safeBrowsingTimeoutMs;
    this.maxUrlLength = v.maxUrlLength;
    this.defaultPermanent = v.defaultPermanent;
    if (this.clickRawDays > this.clickRetentionDays) throw new ConfigError('CLICK_RAW_DAYS must not exceed CLICK_RETENTION_DAYS');
    Object.freeze(this);
  }

  /** Host part of the public base URL, lower-case. */
  get publicHost() {
    return new URL(this.publicBaseUrl).hostname.toLowerCase();
  }

  /**
   * @param {NodeJS.ProcessEnv} [env]
   * @returns {Config}
   */
  static fromEnv(env = process.env) {
    const r = new EnvReader(env);

    const certPath = r.optional('TLS_CERT_PATH');
    const keyPath = r.optional('TLS_KEY_PATH');
    if (Boolean(certPath) !== Boolean(keyPath)) throw new ConfigError('TLS_CERT_PATH and TLS_KEY_PATH must be set together');

    const publicBaseUrl = Config.#origin(r.required('PUBLIC_BASE_URL'), 'PUBLIC_BASE_URL');
    const hashSecret = r.required('HASH_SECRET');
    if (hashSecret.length < Config.MIN_SECRET_LENGTH) throw new ConfigError(`HASH_SECRET must be at least ${Config.MIN_SECRET_LENGTH} characters`);

    return new Config({
      port: r.integer('PORT', 3006, { min: 0, max: 65535 }),
      host: r.optional('HOST') || '0.0.0.0',
      logLevel: r.optional('LOG_LEVEL') || 'info',
      trustProxy: r.boolean('TRUST_PROXY', false),
      tls: certPath ? { certPath, keyPath } : null,
      audit: parseAudit(r),
      bodyLimit: r.integer('BODY_LIMIT', 16_384, { min: 1_024 }),
      dbPath: r.optional('DB_PATH') || './data/shortlink.db',
      dbBackupDir: r.optional('DB_BACKUP_DIR') || undefined,
      apiKeys: Config.#parseApiKeys(r.required('SHORTLINK_API_KEYS')),
      rateLimitMax: r.integer('RATE_LIMIT_MAX', 600, { min: 1 }),
      redirectRateLimitMax: r.integer('REDIRECT_RATE_LIMIT_MAX', 300, { min: 1 }),
      // A 301 is cached by browsers and CDNs for this long: disabling or expiring the link only takes effect after it.
      permanentCacheSec: r.integer('PERMANENT_CACHE_SEC', 300, { min: 0, max: 31_536_000 }),
      publicBaseUrl,
      codeLength: r.integer('CODE_LENGTH', 7, { min: 4, max: 16 }),
      hashSecret,
      clickRetentionDays: r.integer('CLICK_RETENTION_DAYS', 365, { min: 1 }),
      clickRawDays: r.integer('CLICK_RAW_DAYS', 30, { min: 1 }),
      clickFlushMs: r.integer('CLICK_FLUSH_MS', 1_000, { min: 50, max: 60_000 }),
      blockedHosts: r.optional('BLOCKED_HOSTS').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
      maxUrlLength: r.integer('MAX_URL_LENGTH', 2_048, { min: 64, max: 8_192 }),
      defaultPermanent: r.boolean('DEFAULT_PERMANENT', false),
      safeBrowsingApiKey: r.optional('SAFE_BROWSING_API_KEY') || null,
      safeBrowsingTimeoutMs: r.integer('SAFE_BROWSING_TIMEOUT_MS', 3_000, { min: 200, max: 30_000 }),
    });
  }

  /**
   * @param {string} value
   * @param {string} name
   */
  static #origin(value, name) {
    let u;
    try {
      u = new URL(value);
    } catch {
      throw new ConfigError(`${name} must be an absolute URL`);
    }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
      throw new ConfigError(`${name} must be a bare origin like https://s.example.com`);
    }
    return u.origin;
  }

  /**
   * Parse `id:secret[:role],…`. Role defaults to `readwrite`.
   * @param {string} raw
   * @returns {ApiKey[]}
   */
  static #parseApiKeys(raw) {
    return parseApiKeys(raw, 'SHORTLINK_API_KEYS', { roles: ['read', 'write', 'readwrite'], minSecretLength: Config.MIN_SECRET_LENGTH, roleErrorMessage: () => 'must be read, write or readwrite' })
      .map(({ id, secret, role }) => ({ id, secret, role: /** @type {KeyRole} */ (role) }));
  }
}
