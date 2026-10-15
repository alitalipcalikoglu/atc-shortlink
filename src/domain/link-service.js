import { LinkError } from './errors.js';
import { Slug } from './slug.js';
import { Visitor } from './visitor.js';

/** @typedef {import('../store/link-store.js').LinkStore} LinkStore */
/** @typedef {import('../store/click-store.js').ClickStore} ClickStore */
/** @typedef {import('../db.js').Database} Database */
/** @typedef {import('../types.js').LinkRow} LinkRow */
/** @typedef {import('../types.js').LinkInput} LinkInput */
/** @typedef {import('../types.js').LinkPatch} LinkPatch */
/** @typedef {import('../types.js').LinkStatus} LinkStatus */
/** @typedef {import('../types.js').ListFilter} ListFilter */

/**
 * @typedef {object} ServiceOptions
 * @property {number} codeLength
 * @property {string} publicHost
 * @property {string[]} blockedHosts
 * @property {number} maxUrlLength
 * @property {boolean} defaultPermanent
 */

/**
 * @typedef {object} Hit
 * @property {string} ip
 * @property {string} userAgent
 * @property {string} [referer]
 */

/** Use-cases: create, update, delete, list, resolve for redirect, record clicks, statistics. */
export class LinkService {
  static CODE_ATTEMPTS = 5;
  static BATCH_MAX = 500;

  /**
   * @param {object} deps
   * @param {Database} deps.db
   * @param {LinkStore} deps.links
   * @param {ClickStore} deps.clicks
   * @param {Visitor} deps.visitor
   * @param {ServiceOptions} deps.options
   * @param {import('./url-reputation.js').UrlReputation|null} [deps.reputation]  Safe Browsing check; null = off.
   */
  constructor({ db, links, clicks, visitor, options, reputation = null }) {
    this.reputation = reputation;
    this.db = db;
    this.links = links;
    this.clicks = clicks;
    this.visitor = visitor;
    this.options = options;
  }

  /**
   * @param {LinkInput} input
   * @param {string} createdBy  API key id.
   * @param {number} [now]
   * @returns {LinkRow}
   */
  create(input, createdBy, now = Date.now()) {
    const url = this.#url(input.url);
    const expiresAt = LinkService.#expiry(input.expiresAt, now);
    const base = {
      url, permanent: (input.permanent ?? this.options.defaultPermanent) ? 1 : 0, enabled: 1, expires_at: expiresAt,
      max_clicks: input.maxClicks ?? null, tags: LinkService.#tags(input.tags), note: input.note ?? null, created_by: createdBy, created_at: now, updated_at: now,
    };
    if (input.slug !== undefined) {
      if (!Slug.isValid(input.slug)) throw new LinkError('SLUG_RESERVED', 'slug must be 3-64 characters: letters, digits, _ and -, starting with a letter or digit');
      if (Slug.isReserved(input.slug)) throw new LinkError('SLUG_RESERVED', `"${input.slug}" is reserved`);
      if (this.links.byCode(input.slug)) throw new LinkError('SLUG_TAKEN', `"${input.slug}" is already in use`);
      return this.links.insert({ code: input.slug, ...base });
    }
    for (let attempt = 0; attempt < LinkService.CODE_ATTEMPTS; attempt++) {
      const code = Slug.random(this.options.codeLength);
      if (Slug.isReserved(code) || this.links.byCode(code)) continue;
      return this.links.insert({ code, ...base });
    }
    throw new Error(`could not find a free ${this.options.codeLength}-character code after ${LinkService.CODE_ATTEMPTS} attempts; raise CODE_LENGTH`);
  }

  /**
   * Refuse a URL that Safe Browsing lists (no-op without SAFE_BROWSING_API_KEY; fail-open).
   * @param {string} url
   */
  async assertSafe(url) {
    const flagged = this.reputation ? await this.reputation.check([url]) : new Map();
    const threat = flagged.get(url);
    if (threat) throw new LinkError('URL_UNSAFE', `url is listed by Safe Browsing (${threat})`, { threat });
  }

  /**
   * Create many links in one call; every item succeeds or fails on its own.
   * @param {LinkInput[]} inputs  At most BATCH_MAX.
   * @param {string} createdBy
   * @param {number} [now]
   * @returns {Promise<({ index: number, link: LinkRow } | { index: number, error: { code: string, message: string } })[]>}
   */
  async createBatch(inputs, createdBy, now = Date.now()) {
    const flagged = this.reputation ? await this.reputation.check(inputs.map((i) => i.url)) : new Map();
    return inputs.map((input, index) => {
      try {
        const threat = flagged.get(input.url);
        if (threat) throw new LinkError('URL_UNSAFE', `url is listed by Safe Browsing (${threat})`, { threat });
        return { index, link: this.create(input, createdBy, now) };
      } catch (err) {
        if (err instanceof LinkError) return { index, error: { code: err.code, message: err.message } };
        throw err;
      }
    });
  }

  /** @param {string} code */
  get(code) {
    const row = this.links.byCode(code);
    if (!row) throw new LinkError('LINK_NOT_FOUND', 'link not found');
    return row;
  }

  /**
   * @param {string} code
   * @param {LinkPatch} patch
   * @param {number} [now]
   */
  update(code, patch, now = Date.now()) {
    const row = this.get(code);
    const next = { ...row, updated_at: now };
    if (patch.url !== undefined) next.url = this.#url(patch.url);
    if (patch.permanent !== undefined) next.permanent = patch.permanent ? 1 : 0;
    if (patch.enabled !== undefined) next.enabled = patch.enabled ? 1 : 0;
    if (patch.expiresAt !== undefined) next.expires_at = LinkService.#expiry(patch.expiresAt, now);
    if (patch.maxClicks !== undefined) next.max_clicks = patch.maxClicks;
    if (patch.tags !== undefined) next.tags = LinkService.#tags(patch.tags);
    if (patch.note !== undefined) next.note = patch.note;
    return this.links.update(next);
  }

  /** @param {string} code */
  remove(code) {
    if (!this.links.remove(code)) throw new LinkError('LINK_NOT_FOUND', 'link not found');
  }

  /**
   * @param {ListFilter} filter
   * @param {{ limit: number, cursor?: string, now?: number }} page
   */
  list(filter, { limit, cursor, now = Date.now() }) {
    const before = cursor ? Cursor.decode(cursor) : undefined;
    const rows = this.links.list(filter, { limit: limit + 1, before, now });
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? Cursor.encode(last) : null };
  }

  /**
   * @param {LinkRow} row
   * @param {number} [now]
   * @returns {LinkStatus}
   */
  static status(row, now = Date.now()) {
    if (!row.enabled) return 'disabled';
    if (row.expires_at !== null && row.expires_at <= now) return 'expired';
    if (row.max_clicks !== null && row.clicks >= row.max_clicks) return 'exhausted';
    return 'active';
  }

  /**
   * Resolve a code for redirection and record the click. Bots are counted in the click log
   * with `device = bot` but do not consume `maxClicks`.
   *
   * Correctness: for a link with `maxClicks = N`, any number of concurrent callers (same process
   * or different processes/connections sharing the database) can never produce more than N
   * successful (non-bot) resolves between them. `links.hitIfActive()` is a single atomic
   * conditional `UPDATE` — the "still under the limit" check and the increment happen in one
   * statement, so there is no read-then-write gap for two callers to both observe "not yet
   * exhausted" and both succeed. This holds across connections/processes, not just within one:
   * SQLite itself (WAL + a busy-timeout, see `db.js`) serializes the writes, not a process-local
   * mutex — the same guarantee would hold even with no in-process concurrency at all.
   * @param {string} code
   * @param {Hit} hit
   * @param {number} [now]
   * @returns {{ url: string, permanent: boolean }}
   */
  follow(code, hit, now = Date.now()) {
    const device = Visitor.device(hit.userAgent);
    if (device === 'bot') {
      // Bots never consume maxClicks, so there is nothing to make atomic for them — a plain read
      // is exactly as safe here as it always was.
      const row = this.links.byCode(code);
      if (!row) throw new LinkError('LINK_NOT_FOUND', 'link not found');
      const status = LinkService.status(row, now);
      if (status !== 'active') throw new LinkError('LINK_GONE', `link is ${status}`, { status });
      this.clicks.record({ code, at: now, visitor: this.visitor.hash(hit.ip, hit.userAgent), referrer: Visitor.referrerHost(hit.referer, this.options.publicHost), device });
      return { url: row.url, permanent: row.permanent === 1 };
    }

    // The counter is the exact number and enforces maxClicks: one atomic write. The click row is detail, buffered.
    const claimed = this.links.hitIfActive(code, now);
    if (!claimed) throw LinkService.#followFailure(this.links.byCode(code), now);
    this.clicks.record({ code, at: now, visitor: this.visitor.hash(hit.ip, hit.userAgent), referrer: Visitor.referrerHost(hit.referer, this.options.publicHost), device });
    const row = /** @type {LinkRow} */ (this.links.byCode(code));
    return { url: row.url, permanent: row.permanent === 1 };
  }

  /**
   * Classifies why `hitIfActive` returned false — not found, disabled, expired, or exhausted.
   * This read cannot itself grant an extra click (the atomic attempt already happened and
   * failed), so it is purely explanatory, never part of the correctness primitive itself. In the
   * vanishingly narrow window where a concurrent admin change (e.g. raising `maxClicks`) makes the
   * row look `active` again by the time of this read, the failure is still reported as
   * `exhausted` — `hitIfActive` is the one true answer for whether a click was granted; this is
   * only ever about the wording of the error.
   * @param {LinkRow|undefined} row
   * @param {number} now
   */
  static #followFailure(row, now) {
    if (!row) return new LinkError('LINK_NOT_FOUND', 'link not found');
    const status = LinkService.status(row, now);
    const reported = status === 'active' ? 'exhausted' : status;
    return new LinkError('LINK_GONE', `link is ${reported}`, { status: reported });
  }

  /**
   * @param {string} code
   * @param {number} days
   * @param {number} [now]
   */
  stats(code, days, now = Date.now()) {
    const row = this.get(code);
    const since = now - days * 86_400_000;
    return { code, days, since, total: row.clicks, ...this.clicks.stats(code, since), recent: this.clicks.recent(code, 20) };
  }

  /**
   * @param {number} days
   * @param {number} [now]
   */
  overview(days, now = Date.now()) {
    const since = now - days * 86_400_000;
    return { days, since, links: this.links.counts(now), clicksInWindow: this.clicks.countSince(since), topLinks: this.links.top(since, 10) };
  }

  /** @param {string} raw */
  #url(raw) {
    if (raw.length > this.options.maxUrlLength) throw new LinkError('INVALID_URL', `url is longer than ${this.options.maxUrlLength} characters`);
    let u;
    try {
      u = new URL(raw);
    } catch {
      throw new LinkError('INVALID_URL', 'url must be absolute');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new LinkError('INVALID_URL', 'url must use http or https');
    if (u.username || u.password) throw new LinkError('INVALID_URL', 'url must not contain credentials');
    const host = u.hostname.toLowerCase();
    if (host === this.options.publicHost) throw new LinkError('INVALID_URL', 'url must not point at this service');
    if (this.options.blockedHosts.some((b) => host === b || host.endsWith(`.${b}`))) throw new LinkError('HOST_BLOCKED', `host "${host}" is not allowed`);
    return u.href;
  }

  /**
   * @param {string|null|undefined} iso
   * @param {number} now
   */
  static #expiry(iso, now) {
    if (iso === undefined || iso === null) return null;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) throw new LinkError('INVALID_EXPIRY', 'expiresAt is not a valid ISO 8601 timestamp');
    if (t <= now) throw new LinkError('INVALID_EXPIRY', 'expiresAt must be in the future');
    return t;
  }

  /** @param {string[]|undefined} tags */
  static #tags(tags) {
    return JSON.stringify([...new Set((tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))].sort());
  }
}

/** Opaque keyset cursor: `created_at:code` in base64url. */
export class Cursor {
  /** @param {LinkRow} row */
  static encode(row) {
    return Buffer.from(`${row.created_at}:${row.code}`).toString('base64url');
  }

  /** @param {string} cursor */
  static decode(cursor) {
    const m = /^(\d{1,16}):([A-Za-z0-9_-]{1,64})$/.exec(Buffer.from(cursor, 'base64url').toString());
    if (!m) throw new LinkError('INVALID_CURSOR', 'cursor is not valid');
    return { createdAt: Number(m[1]), code: m[2] };
  }
}
