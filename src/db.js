import { Database as CoreDatabase } from '@atc-web/atc-service-core/db';

/** SQLite connection with schema migrations applied on open. */
export class Database extends CoreDatabase {
  static MIGRATIONS = [
    `
    CREATE TABLE links (
      code          TEXT PRIMARY KEY,
      url           TEXT NOT NULL,
      permanent     INTEGER NOT NULL DEFAULT 0,
      enabled       INTEGER NOT NULL DEFAULT 1,
      expires_at    INTEGER,
      max_clicks    INTEGER,
      clicks        INTEGER NOT NULL DEFAULT 0,
      last_click_at INTEGER,
      tags          TEXT NOT NULL DEFAULT '[]',
      note          TEXT,
      created_by    TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX links_created ON links (created_at DESC, code);
    CREATE INDEX links_expires ON links (expires_at);

    CREATE TABLE clicks (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      code      TEXT NOT NULL REFERENCES links(code) ON DELETE CASCADE,
      at        INTEGER NOT NULL,
      visitor   TEXT NOT NULL,
      referrer  TEXT,
      device    TEXT NOT NULL
    );
    CREATE INDEX clicks_code_at ON clicks (code, at);
    CREATE INDEX clicks_at ON clicks (at);
    `,
  ];
}
