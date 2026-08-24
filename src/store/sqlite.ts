/**
 * The one place `node:sqlite` is imported.
 *
 * It is a real core module, but it is deliberately absent from `module.builtinModules` because,
 * uniquely, it cannot be imported without the `node:` prefix. Bundlers resolve builtins from
 * that list, so a static `import "node:sqlite"` gets its prefix stripped and turns into a
 * lookup for a package named `sqlite`, which does not exist. Requiring it through
 * `createRequire` leaves nothing for a bundler to analyze, and the runtime resolves it the way
 * it always would.
 *
 * Confined to this module so the workaround is one file rather than a rule everyone has to
 * remember, and so it can be deleted when the toolchain catches up.
 */

import { createRequire } from "node:module";

export interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (location: string) => SqliteDatabase;
}

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as SqliteModule;

export { DatabaseSync };
