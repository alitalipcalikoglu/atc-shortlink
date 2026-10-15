/**
 * Domain error with a stable machine-readable code and the HTTP status the API maps it to.
 */
export class LinkError extends Error {
  /** @type {Record<string, number>} */
  static STATUS = {
    LINK_NOT_FOUND: 404,
    LINK_GONE: 410,
    SLUG_TAKEN: 409,
    SLUG_RESERVED: 400,
    INVALID_URL: 400,
    HOST_BLOCKED: 400,
    URL_UNSAFE: 400,
    INVALID_EXPIRY: 400,
    QR_TOO_LONG: 400,
    INVALID_CURSOR: 400,
    FORBIDDEN: 403,
  };

  /**
   * @param {keyof typeof LinkError.STATUS} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'LinkError';
    this.code = code;
    this.statusCode = LinkError.STATUS[code];
    this.details = details;
  }
}
