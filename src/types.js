/**
 * Shared JSDoc typedefs for the shortlink service. No runtime exports.
 */

/** @typedef {'read'|'write'|'readwrite'} KeyRole */

/**
 * @typedef {object} ApiKey
 * @property {string} id
 * @property {string} secret
 * @property {KeyRole} role
 */

/**
 * Plain values accepted by the `Config` constructor.
 * @typedef {object} ConfigValues
 * @property {number} port
 * @property {string} host
 * @property {string} logLevel
 * @property {boolean} trustProxy
 * @property {{ certPath: string, keyPath: string }|null} tls
 * @property {{ url: string, apiKey: string }|null} audit   Audit service to forward events to; null = off.
 * @property {number} bodyLimit
 * @property {string} dbPath
 * @property {string} [dbBackupDir]
 * @property {ApiKey[]} apiKeys
 * @property {number} rateLimitMax
 * @property {number} redirectRateLimitMax
 * @property {number} permanentCacheSec  Cache-Control max-age of a 301 redirect.
 * @property {string} publicBaseUrl        Origin the short links are served from, no trailing slash.
 * @property {number} codeLength
 * @property {string} hashSecret           Salt for visitor hashing.
 * @property {number} clickRetentionDays
 * @property {string[]} blockedHosts       Lower-case; exact or parent-domain match.
 * @property {number} maxUrlLength
 * @property {boolean} defaultPermanent
 */

/** @typedef {import('./config.js').Config} Config */

/**
 * @typedef {object} LinkRow
 * @property {string} code
 * @property {string} url
 * @property {number} permanent      1 = 301, 0 = 302.
 * @property {number} enabled
 * @property {number|null} expires_at
 * @property {number|null} max_clicks
 * @property {number} clicks
 * @property {number|null} last_click_at
 * @property {string} tags           JSON array of strings.
 * @property {string|null} note
 * @property {string} created_by     API key id.
 * @property {number} created_at
 * @property {number} updated_at
 */

/** @typedef {'active'|'disabled'|'expired'|'exhausted'} LinkStatus */

/** @typedef {'desktop'|'mobile'|'bot'|'other'} Device */

/**
 * @typedef {object} ClickRow
 * @property {number} id
 * @property {string} code
 * @property {number} at
 * @property {string} visitor        Salted hash of address + user agent.
 * @property {string|null} referrer  Host only.
 * @property {Device} device
 */

/**
 * @typedef {object} LinkInput
 * @property {string} url
 * @property {string} [slug]
 * @property {boolean} [permanent]
 * @property {string|null} [expiresAt]   ISO 8601.
 * @property {number|null} [maxClicks]
 * @property {string[]} [tags]
 * @property {string|null} [note]
 */

/**
 * @typedef {object} LinkPatch
 * @property {string} [url]
 * @property {boolean} [permanent]
 * @property {boolean} [enabled]
 * @property {string|null} [expiresAt]
 * @property {number|null} [maxClicks]
 * @property {string[]} [tags]
 * @property {string|null} [note]
 */

/**
 * @typedef {object} ListFilter
 * @property {string} [q]        Substring of code or URL.
 * @property {string} [tag]
 * @property {LinkStatus} [status]
 * @property {string} [createdBy]
 */

/** @typedef {import('fastify').FastifyBaseLogger} Logger */

export {};
