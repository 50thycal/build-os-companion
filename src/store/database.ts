/**
 * Opening and migrating the database.
 *
 * `node:sqlite` is synchronous, which is why the durable ledger can implement the same
 * `EventLedger` interface as the in-memory one rather than forcing every caller to become
 * async. That is not a small detail: it means the projection, attention and feed layers are
 * untouched by persistence existing.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SqliteDatabase } from "./sqlite.ts";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema.ts";

export type Database = SqliteDatabase;

export interface OpenOptions {
  /** File path, or `:memory:` for a throwaway database. */
  location: string;
}

export function openDatabase(options: OpenOptions): Database {
  if (options.location !== ":memory:") {
    mkdirSync(dirname(options.location), { recursive: true });
  }

  const db = new DatabaseSync(options.location);

  // Write-ahead logging so a reader (the web app rendering a page) is never blocked by the
  // writer (a sync in progress). Foreign keys on for the usual reasons.
  if (options.location !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  migrate(db);
  return db;
}

/**
 * Apply migrations forward from whatever version the file is at.
 *
 * `user_version` is SQLite's own integer, which means the schema version travels inside the
 * database file rather than beside it — a database copied to another machine cannot arrive
 * without knowing what it is.
 */
export function migrate(db: Database): void {
  const current = Number(
    (db.prepare("PRAGMA user_version").get() as { user_version?: number })?.user_version ?? 0,
  );

  for (let version = current; version < MIGRATIONS.length; version += 1) {
    db.exec("BEGIN");
    try {
      for (const statement of MIGRATIONS[version]!) db.exec(statement);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  const after = Number(
    (db.prepare("PRAGMA user_version").get() as { user_version?: number })?.user_version ?? 0,
  );
  if (after !== SCHEMA_VERSION) {
    throw new Error(`schema version ${after} after migration, expected ${SCHEMA_VERSION}`);
  }
}

/** Run `work` in a transaction, rolling back if it throws. */
export function transaction<T>(db: Database, work: () => T): T {
  db.exec("BEGIN");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
