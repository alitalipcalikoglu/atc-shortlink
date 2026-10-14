/** @typedef {import('../db.js').Database} Database */
/** @typedef {import('../types.js').ClickRow} ClickRow */

/**
 * Click log and its aggregates. The per-link counter is the exact, synchronous number (it enforces
 * `maxClicks`); this log is detail, so rows are buffered in memory and written in one transaction per
 * flush (a timer, a full buffer, and before every read), which keeps a redirect to one tiny write. A
 * crash loses at most the unflushed rows, never a count. Rows older than the raw window are rolled up
 * into one row per link and day (`click_days`) and deleted.
 */
export class ClickStore {
  static MAX_BUFFER = 500;

  /** @param {Database} db */
  constructor(db) {
    this.db = db;
    /** @type {Omit<ClickRow, 'id'>[]} */
    this.buffer = [];
    /** @type {NodeJS.Timeout|null} */
    this.timer = null;
    this.stmt = {
      insert: db.prepare(`INSERT INTO clicks (code, at, visitor, referrer, device) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM links WHERE code = ?)`),
      rollupSelect: db.prepare(`SELECT code, (at / 86400000) * 86400000 AS day, SUM(CASE WHEN device <> 'bot' THEN 1 ELSE 0 END) AS clicks, SUM(CASE WHEN device = 'bot' THEN 1 ELSE 0 END) AS bots, COUNT(DISTINCT CASE WHEN device <> 'bot' THEN visitor END) AS visitors FROM clicks WHERE at < ? GROUP BY code, day`),
      rollupUpsert: db.prepare(`INSERT INTO click_days (code, day, clicks, bots, visitors) VALUES (?, ?, ?, ?, ?) ON CONFLICT (code, day) DO UPDATE SET clicks = clicks + excluded.clicks, bots = bots + excluded.bots, visitors = visitors + excluded.visitors`),
      rollupDelete: db.prepare(`DELETE FROM clicks WHERE at < ?`),
      daysTotals: db.prepare(`SELECT COALESCE(SUM(clicks), 0) AS clicks, COALESCE(SUM(bots), 0) AS bots, COALESCE(SUM(visitors), 0) AS visitors FROM click_days WHERE code = ? AND day >= ?`),
      daysByDay: db.prepare(`SELECT day, clicks, visitors FROM click_days WHERE code = ? AND day >= ? ORDER BY day`),
      daysPurge: db.prepare(`DELETE FROM click_days WHERE day < ?`),
      daysSince: db.prepare(`SELECT COALESCE(SUM(clicks + bots), 0) AS n FROM click_days WHERE day >= ?`),
      totals: db.prepare(`SELECT COUNT(*) AS clicks, COUNT(DISTINCT CASE WHEN device <> 'bot' THEN visitor END) AS visitors, SUM(CASE WHEN device = 'bot' THEN 1 ELSE 0 END) AS bots FROM clicks WHERE code = ? AND at >= ?`),
      byDay: db.prepare(`SELECT (at / 86400000) * 86400000 AS day, COUNT(*) AS clicks, COUNT(DISTINCT visitor) AS visitors FROM clicks WHERE code = ? AND at >= ? AND device <> 'bot' GROUP BY day ORDER BY day`),
      byReferrer: db.prepare(`SELECT COALESCE(referrer, '') AS referrer, COUNT(*) AS n FROM clicks WHERE code = ? AND at >= ? AND device <> 'bot' GROUP BY referrer ORDER BY n DESC LIMIT 10`),
      byDevice: db.prepare(`SELECT device, COUNT(*) AS n FROM clicks WHERE code = ? AND at >= ? GROUP BY device`),
      recent: db.prepare(`SELECT id, code, at, visitor, referrer, device FROM clicks WHERE code = ? ORDER BY id DESC LIMIT ?`),
      since: db.prepare(`SELECT COUNT(*) AS n FROM clicks WHERE at >= ?`),
      purge: db.prepare(`DELETE FROM clicks WHERE at < ?`),
      total: db.prepare(`SELECT COUNT(*) AS n FROM clicks`),
    };
  }

  /**
   * Queue one click row; written by the next {@link flush}.
   * @param {Omit<ClickRow, 'id'>} c
   */
  record(c) {
    this.buffer.push(c);
    if (this.buffer.length >= ClickStore.MAX_BUFFER) this.flush();
  }

  /** Write every buffered row in one transaction (rows of links deleted meanwhile are dropped). @returns {number} rows written */
  flush() {
    if (this.buffer.length === 0) return 0;
    const rows = this.buffer;
    this.buffer = [];
    this.db.transaction(() => { for (const c of rows) this.stmt.insert.run(c.code, c.at, c.visitor, c.referrer, c.device, c.code); });
    return rows.length;
  }

  /** @param {number} flushMs */
  start(flushMs) {
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.flush(); } catch { /* retried at the next flush */ } }, flushMs);
    this.timer.unref();
  }

  /** Stop the timer and write what is left. */
  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush();
  }

  /**
   * Roll raw rows older than `before` (a day boundary) into `click_days`, then delete them.
   * @param {number} before
   * @returns {number} raw rows rolled up
   */
  rollup(before) {
    this.flush();
    return this.db.transaction(() => {
      const days = /** @type {{ code: string, day: number, clicks: number, bots: number, visitors: number }[]} */ (this.stmt.rollupSelect.all(before));
      for (const d of days) this.stmt.rollupUpsert.run(d.code, d.day, d.clicks, d.bots, d.visitors);
      return Number(this.stmt.rollupDelete.run(before).changes);
    });
  }

  /**
   * @param {string} code
   * @param {number} since
   */
  stats(code, since) {
    this.flush();
    const t = /** @type {{ clicks: number, visitors: number, bots: number|null }} */ (this.stmt.totals.get(code, since));
    const dayFrom = Math.ceil(since / 86_400_000) * 86_400_000;
    const old = /** @type {{ clicks: number, bots: number, visitors: number }} */ (this.stmt.daysTotals.get(code, dayFrom));
    const oldDays = /** @type {{ day: number, clicks: number, visitors: number }[]} */ (this.stmt.daysByDay.all(code, dayFrom));
    const n = (/** @type {any} */ r) => Number(r.n);
    return {
      clicks: Number(t.clicks) + Number(old.clicks) + Number(old.bots),
      visitors: Number(t.visitors) + Number(old.visitors),
      bots: Number(t.bots ?? 0) + Number(old.bots),
      byDay: [...oldDays, .../** @type {{ day: number, clicks: number, visitors: number }[]} */ (this.stmt.byDay.all(code, since))].map((r) => ({ day: new Date(Number(r.day)).toISOString().slice(0, 10), clicks: Number(r.clicks), visitors: Number(r.visitors) })),
      byReferrer: /** @type {{ referrer: string, n: number }[]} */ (this.stmt.byReferrer.all(code, since)).map((r) => ({ referrer: r.referrer || null, clicks: n(r) })),
      byDevice: Object.fromEntries(/** @type {{ device: string, n: number }[]} */ (this.stmt.byDevice.all(code, since)).map((r) => [r.device, n(r)])),
    };
  }

  /**
   * @param {string} code
   * @param {number} limit
   * @returns {ClickRow[]}
   */
  recent(code, limit) {
    this.flush();
    return /** @type {ClickRow[]} */ (this.stmt.recent.all(code, limit));
  }

  /** @param {number} since */
  countSince(since) {
    this.flush();
    return Number(/** @type {{ n: number }} */ (this.stmt.since.get(since)).n) + Number(/** @type {{ n: number }} */ (this.stmt.daysSince.get(Math.ceil(since / 86_400_000) * 86_400_000)).n);
  }

  count() {
    this.flush();
    return Number(/** @type {{ n: number }} */ (this.stmt.total.get()).n);
  }

  /** @param {number} before */
  purge(before) {
    this.flush();
    return Number(this.stmt.purge.run(before).changes) + Number(this.stmt.daysPurge.run(Math.floor(before / 86_400_000) * 86_400_000).changes);
  }
}
