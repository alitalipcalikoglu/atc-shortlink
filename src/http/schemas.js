/** JSON Schemas for the HTTP surface. */
export class Schemas {
  static code = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$' };
  static url = { type: 'string', minLength: 8, maxLength: 8192 };
  static tags = { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 40, pattern: '^[^,]+$' } };
  static note = { type: 'string', maxLength: 500, nullable: true };
  static expiresAt = { type: 'string', maxLength: 40, nullable: true };
  static maxClicks = { type: 'integer', minimum: 1, maximum: 1_000_000_000, nullable: true };

  /**
   * @param {string[]} required
   * @param {Record<string, object>} properties
   */
  static body(required, properties) {
    return { type: 'object', additionalProperties: false, required, properties };
  }

  static create = Schemas.body(['url'], {
    url: Schemas.url, slug: Schemas.code, permanent: { type: 'boolean' }, expiresAt: Schemas.expiresAt, maxClicks: Schemas.maxClicks, tags: Schemas.tags, note: Schemas.note,
  });

  static batch = Schemas.body(['links'], { links: { type: 'array', minItems: 1, maxItems: 500, items: Schemas.create } });

  static patch = {
    type: 'object', additionalProperties: false, minProperties: 1,
    properties: { url: Schemas.url, permanent: { type: 'boolean' }, enabled: { type: 'boolean' }, expiresAt: Schemas.expiresAt, maxClicks: Schemas.maxClicks, tags: Schemas.tags, note: Schemas.note },
  };

  static codeParams = { type: 'object', properties: { code: Schemas.code }, required: ['code'] };
  /** Public paths accept anything short; an unknown shape is a 404, not a validation error. */
  static publicParams = { type: 'object', properties: { code: { type: 'string', minLength: 1, maxLength: 80 } }, required: ['code'] };

  static listQuery = {
    type: 'object', additionalProperties: false,
    properties: {
      q: { type: 'string', minLength: 1, maxLength: 200 },
      tag: { type: 'string', minLength: 1, maxLength: 40 },
      status: { type: 'string', enum: ['active', 'disabled', 'expired', 'exhausted'] },
      createdBy: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
      limit: { type: 'string', pattern: '^([1-9]|[1-9][0-9]|1[0-9][0-9]|200)$' },
      cursor: { type: 'string', maxLength: 200 },
    },
  };

  static daysQuery = { type: 'object', additionalProperties: false, properties: { days: { type: 'string', pattern: '^([1-9]|[1-9][0-9]|[1-3][0-9][0-9])$' } } };

  static qrQuery = {
    type: 'object', additionalProperties: false,
    properties: {
      format: { type: 'string', enum: ['svg', 'png'] },
      scale: { type: 'string', pattern: '^([1-9]|1[0-9]|20)$' },
      margin: { type: 'string', pattern: '^[0-8]$' },
    },
  };

  static qrTextQuery = { type: 'object', additionalProperties: false, required: ['text'], properties: { ...Schemas.qrQuery.properties, text: { type: 'string', minLength: 1, maxLength: 1024 } } };
}
