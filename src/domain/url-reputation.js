/**
 * Optional malicious-URL check against the Google Safe Browsing Lookup API (v4). One request per
 * create or batch (up to 500 URLs). Fail-open by design: when the API cannot be asked (timeout,
 * network, quota), the URLs are accepted and the failure is logged, so a third-party outage never
 * stops link creation. `BLOCKED_HOSTS` stays the hard, local block list.
 */
export class UrlReputation {
  static ENDPOINT = 'https://safebrowsing.googleapis.com/v4/threatMatches:find';
  static MAX_ENTRIES = 500;
  static THREATS = ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'];

  /**
   * @param {object} o
   * @param {string} o.apiKey
   * @param {number} o.timeoutMs
   * @param {{ warn: (obj: object, msg: string) => void }} o.log
   * @param {typeof fetch} [o.fetch]
   * @param {string} [o.endpoint]
   */
  constructor({ apiKey, timeoutMs, log, fetch: fetchImpl = fetch, endpoint = UrlReputation.ENDPOINT }) {
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.fetch = fetchImpl;
    this.endpoint = endpoint;
    this.failures = 0;
    this.flagged = 0;
  }

  /**
   * @param {string[]} urls  At most MAX_ENTRIES.
   * @returns {Promise<Map<string, string>>}  url to threat type, only for flagged URLs.
   */
  async check(urls) {
    /** @type {Map<string, string>} */
    const out = new Map();
    const unique = [...new Set(urls)];
    if (!unique.length) return out;
    try {
      const res = await this.fetch(`${this.endpoint}?key=${encodeURIComponent(this.apiKey)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client: { clientId: 'atc-shortlink', clientVersion: '1' },
          threatInfo: { threatTypes: UrlReputation.THREATS, platformTypes: ['ANY_PLATFORM'], threatEntryTypes: ['URL'], threatEntries: unique.map((url) => ({ url })) },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = /** @type {{ matches?: { threat?: { url?: string }, threatType?: string }[] }} */ (await res.json());
      for (const m of body.matches ?? []) if (m.threat?.url) out.set(m.threat.url, m.threatType ?? 'THREAT');
      this.flagged += out.size;
    } catch (err) {
      this.failures += 1;
      this.log.warn({ err: err instanceof Error ? err.message : String(err), urls: unique.length }, 'safe browsing check failed; urls accepted unchecked');
    }
    return out;
  }
}
