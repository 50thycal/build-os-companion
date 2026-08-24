/**
 * Start the Companion.
 *
 * ```bash
 * GITHUB_TOKEN=... npm start
 * ```
 *
 * Reads `companion.config.json`, opens the database, optionally syncs, and serves.
 */

import { resolve } from "node:path";
import { CompanionApp } from "../app/companion-app.ts";
import { applyConfig, loadConfig } from "../config/followed.ts";
import { HttpGitHubClient } from "../ingest/github/client.ts";
import { SqliteEventLedger } from "../ledger/sqlite-ledger.ts";
import { openDatabase } from "../store/database.ts";
import { CompanionStore } from "../store/store.ts";
import { createCompanionServer } from "../web/server.ts";

const configPath = resolve(process.env.COMPANION_CONFIG ?? "companion.config.json");
const dbPath = resolve(process.env.COMPANION_DB ?? "data/companion.db");
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";

const config = loadConfig(configPath);
const db = openDatabase({ location: dbPath });
const store = new CompanionStore(db);
const ledger = new SqliteEventLedger(db);

const projects = applyConfig(store, config, new Date());

const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
const app = new CompanionApp({
  store,
  ledger,
  ownerLogin: config.ownerLogin,
  github: token ? () => new HttpGitHubClient({ token }) : undefined,
});

console.log(`[companion] config   ${configPath}`);
console.log(`[companion] database ${dbPath}`);
console.log(`[companion] owner    ${config.ownerLogin}`);
console.log(`[companion] projects ${projects.map((p) => p.repositoryFullName).join(", ") || "none"}`);
if (!token) {
  console.log("[companion] no GITHUB_TOKEN — serving stored state only, syncing is disabled");
}

if (token && process.env.COMPANION_SYNC_ON_START !== "0") {
  console.log("[companion] syncing…");
  try {
    const { results } = await app.sync();
    for (const result of results) {
      console.log(
        `[companion]   ${result.projectId}: +${result.appended.length} events` +
          (result.syncFailed ? ` (failed: ${result.syncFailed})` : ""),
      );
    }
  } catch (error) {
    console.error("[companion] initial sync failed:", (error as Error).message);
  }
}

const server = createCompanionServer({ app });
server.listen(port, host, () => {
  console.log(`[companion] http://localhost:${port}`);
});

/** Close the database cleanly so WAL is checkpointed rather than left for recovery. */
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
