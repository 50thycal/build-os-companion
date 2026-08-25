/**
 * The durable schema.
 *
 * Four kinds of thing are stored, and keeping them apart is what makes "what changed since I
 * last checked" answerable:
 *
 * - **events** — append-only history. Never updated, never deleted.
 * - **snapshots** — the latest observed state of each project's canonical artifacts. A cache of
 *   what GitHub says, replaced wholesale each sync.
 * - **attention** — one row per distinct situation, carrying when it first appeared and when it
 *   stopped being true. This is what lets the briefing say "resolved" as well as "new".
 * - **cursors** — where the owner has read up to, and where each project's sync got to.
 *
 * SQLite via `node:sqlite`: no dependency, no server, one file to back up. For a single-owner
 * application that is the right amount of database, and the `EventLedger` interface means the
 * choice stays reversible.
 */

export const SCHEMA_VERSION = 2;

/**
 * `seq` is the spine of the whole design.
 *
 * It is assigned on insertion, so it orders events by *when the Companion learned them* rather
 * than by when they happened. The read cursor is a sequence number for exactly that reason: a
 * pull request opened three days ago but first observed today is new to the owner, and an event
 * that has already been shown must not resurface because something backdated arrived beside it.
 * Ordering the cursor by `occurred_at` would get both cases wrong.
 */
export const MIGRATIONS: string[][] = [
  // ---- v1 -----------------------------------------------------------------
  [
    `CREATE TABLE IF NOT EXISTS events (
       seq                 INTEGER PRIMARY KEY AUTOINCREMENT,
       source_fingerprint  TEXT NOT NULL UNIQUE,
       id                  TEXT NOT NULL,
       project_id          TEXT NOT NULL,
       event_type          TEXT NOT NULL,
       occurred_at         TEXT NOT NULL,
       ingested_at         TEXT NOT NULL,
       importance          TEXT NOT NULL,
       actor_type          TEXT NOT NULL,
       actor_name          TEXT NOT NULL,
       workstream_id       TEXT,
       pull_request_number INTEGER,
       session_id          TEXT,
       summary_short       TEXT NOT NULL,
       summary_detail      TEXT,
       source_json         TEXT NOT NULL,
       raw_json            TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS events_project_occurred ON events (project_id, occurred_at)`,
    `CREATE INDEX IF NOT EXISTS events_project_seq ON events (project_id, seq)`,

    `CREATE TABLE IF NOT EXISTS projects (
       id                   TEXT PRIMARY KEY,
       repository_full_name TEXT NOT NULL UNIQUE,
       owner_user_id        TEXT NOT NULL,
       display_name         TEXT,
       default_branch       TEXT NOT NULL DEFAULT 'main',
       build_os_detected    INTEGER NOT NULL DEFAULT 0,
       build_os_version     TEXT,
       paths_json           TEXT NOT NULL,
       enabled              INTEGER NOT NULL DEFAULT 1,
       created_at           TEXT NOT NULL,
       last_synced_at       TEXT,
       stale_since          TEXT,
       last_error           TEXT
     )`,

    `CREATE TABLE IF NOT EXISTS project_snapshots (
       project_id TEXT NOT NULL,
       kind       TEXT NOT NULL,
       json       TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       PRIMARY KEY (project_id, kind)
     )`,

    `CREATE TABLE IF NOT EXISTS attention_items (
       id                  TEXT PRIMARY KEY,
       project_id          TEXT NOT NULL,
       entity_type         TEXT NOT NULL,
       entity_id           TEXT NOT NULL,
       severity            TEXT NOT NULL,
       reason_code         TEXT NOT NULL,
       reason_text         TEXT NOT NULL,
       recommended_action  TEXT NOT NULL,
       evidence_json       TEXT NOT NULL,
       first_seen_at       TEXT NOT NULL,
       first_seen_seq      INTEGER NOT NULL,
       last_seen_at        TEXT NOT NULL,
       cleared_at          TEXT,
       cleared_seq         INTEGER
     )`,
    `CREATE INDEX IF NOT EXISTS attention_project ON attention_items (project_id, cleared_at)`,

    `CREATE TABLE IF NOT EXISTS read_cursor (
       owner_user_id   TEXT PRIMARY KEY,
       last_checked_at TEXT NOT NULL,
       last_seq        INTEGER NOT NULL
     )`,
  ],

  // ---- v2 -----------------------------------------------------------------
  // The adoption boundary has to survive a restart. It is the date that decides whether a
  // workstream predating the project's move to v0.5 is judged by the v0.5 review gate, so a
  // database that forgot it would start accusing settled work after every deploy.
  [`ALTER TABLE projects ADD COLUMN build_os_adopted_at TEXT`],
];
