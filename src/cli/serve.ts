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
import { resolveAuth } from "../web/auth.ts";
import { startScheduler } from "../sync/scheduler.ts";

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

const auth = resolveAuth({
  password: process.env.COMPANION_PASSWORD,
  allowNoAuth: process.env.COMPANION_ALLOW_NO_AUTH === "1",
});

// Default to twenty minutes when there is a token to sync with. Nothing here is latency
// sensitive — it is polling — and a passive refresh is what makes the app worth opening.
const syncIntervalMinutes = Number(process.env.COMPANION_SYNC_INTERVAL_MINUTES ?? (token ? 20 : 0));
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

if (auth.mode === "REQUIRED") console.log("[companion] auth     password required");
else if (auth.mode === "DISABLED") console.warn("[companion] auth     DISABLED — every visitor sees this owner's private project state");
else console.error("[companion] auth     NOT CONFIGURED — set COMPANION_PASSWORD; refusing to serve until you do");

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

const scheduler = startScheduler({
  intervalMinutes: syncIntervalMinutes,
  sync: () => app.sync(),
  onResult: (result) => {
    const appended = result.results.reduce((n, r) => n + r.appended.length, 0);
    const failed = result.results.filter((r) => r.syncFailed).length;
    if (appended > 0 || failed > 0) {
      console.log(`[companion] scheduled sync: +${appended} events${failed > 0 ? `, ${failed} failing` : ""}`);
    }
  },
  onError: (error) => console.error("[companion] scheduled sync failed:", (error as Error).message),
});

if (scheduler.running) console.log(`[companion] sync     every ${syncIntervalMinutes} minutes`);

const server = createCompanionServer({ app, auth });
server.listen(port, host, () => {
  console.log(`[companion] listening on ${host}:${port}`);
});

/** Close the database cleanly so WAL is checkpointed rather than left for recovery. */
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    scheduler.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
