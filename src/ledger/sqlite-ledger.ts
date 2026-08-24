/**
 * The durable event ledger.
 *
 * Implements exactly the same `EventLedger` interface as the in-memory one, so nothing in the
 * projection, attention or feed layers knows persistence exists. `node:sqlite` being
 * synchronous is what makes that possible without turning the whole pipeline async.
 *
 * Idempotency is enforced by the database rather than by application code: `source_fingerprint`
 * is `UNIQUE`, and an insert that collides is counted as a duplicate instead of failing. That
 * distinction matters across restarts — the in-memory ledger forgot every fingerprint when the
 * process ended, so a re-sync after a restart would have re-appended everything and the owner
 * would have seen a week of history announce itself as new.
 */

import type { CompanionEvent, EventDraft, EventType, Importance } from "../domain/events.ts";
import type { ActorType, SourceRef } from "../domain/index.ts";
import type { Database } from "../store/database.ts";
import { transaction } from "../store/database.ts";
import type { AppendResult, EventLedger } from "./ledger.ts";
import { materialize } from "./ledger.ts";

interface EventRow {
  seq: number;
  source_fingerprint: string;
  id: string;
  project_id: string;
  event_type: string;
  occurred_at: string;
  ingested_at: string;
  importance: string;
  actor_type: string;
  actor_name: string;
  workstream_id: string | null;
  pull_request_number: number | null;
  session_id: string | null;
  summary_short: string;
  summary_detail: string | null;
  source_json: string;
  raw_json: string | null;
}

/** An event together with the sequence number it was stored at. */
export interface SequencedEvent {
  event: CompanionEvent;
  seq: number;
}

function toEvent(row: EventRow): CompanionEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    eventType: row.event_type as EventType,
    source: JSON.parse(row.source_json) as SourceRef,
    actor: { type: row.actor_type as ActorType, name: row.actor_name },
    occurredAt: row.occurred_at,
    ingestedAt: row.ingested_at,
    workstreamId: row.workstream_id ?? undefined,
    pullRequestNumber: row.pull_request_number ?? undefined,
    sessionId: row.session_id ?? undefined,
    importance: row.importance as Importance,
    summaryShort: row.summary_short,
    summaryDetail: row.summary_detail ?? undefined,
    raw: row.raw_json ? (JSON.parse(row.raw_json) as Record<string, unknown>) : undefined,
    sourceFingerprint: row.source_fingerprint,
  };
}

const SELECT = `SELECT seq, source_fingerprint, id, project_id, event_type, occurred_at,
  ingested_at, importance, actor_type, actor_name, workstream_id, pull_request_number,
  session_id, summary_short, summary_detail, source_json, raw_json FROM events`;

/**
 * Chronological by `occurred_at`, with storage order as the tie-break — the same ordering the
 * in-memory ledger promises, so swapping implementations cannot reorder a feed.
 */
const CHRONOLOGICAL = ` ORDER BY occurred_at ASC, seq ASC`;

export class SqliteEventLedger implements EventLedger {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  append(drafts: EventDraft[], now: Date = new Date()): AppendResult {
    const appended: CompanionEvent[] = [];
    let duplicates = 0;

    // One transaction for the batch: a sync either records what it saw or records nothing, and
    // never leaves half a poll cycle behind for the next run to misinterpret as history.
    transaction(this.#db, () => {
      const insert = this.#db.prepare(
        `INSERT OR IGNORE INTO events (
           source_fingerprint, id, project_id, event_type, occurred_at, ingested_at, importance,
           actor_type, actor_name, workstream_id, pull_request_number, session_id,
           summary_short, summary_detail, source_json, raw_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      for (const draft of drafts) {
        const event = materialize(draft, now);
        const result = insert.run(
          event.sourceFingerprint,
          event.id,
          event.projectId,
          event.eventType,
          event.occurredAt,
          event.ingestedAt,
          event.importance,
          event.actor.type,
          event.actor.name,
          event.workstreamId ?? null,
          event.pullRequestNumber ?? null,
          event.sessionId ?? null,
          event.summaryShort,
          event.summaryDetail ?? null,
          JSON.stringify(event.source),
          event.raw ? JSON.stringify(event.raw) : null,
        );

        // `INSERT OR IGNORE` changes nothing when the fingerprint is already present. That is
        // the idempotency guarantee, enforced by the unique index rather than by a prior read.
        if (result.changes === 0) duplicates += 1;
        else appended.push(event);
      }
    });

    return { appended, duplicates };
  }

  all(): CompanionEvent[] {
    return (this.#db.prepare(SELECT + CHRONOLOGICAL).all() as unknown as EventRow[]).map(toEvent);
  }

  forProject(projectId: string): CompanionEvent[] {
    return (
      this.#db.prepare(`${SELECT} WHERE project_id = ?${CHRONOLOGICAL}`).all(projectId) as unknown as EventRow[]
    ).map(toEvent);
  }

  /** Events that *happened* after a timestamp. Activity windows, not the read cursor. */
  since(isoTimestamp: string): CompanionEvent[] {
    return (
      this.#db.prepare(`${SELECT} WHERE occurred_at > ?${CHRONOLOGICAL}`).all(isoTimestamp) as unknown as EventRow[]
    ).map(toEvent);
  }

  has(sourceFingerprint: string): boolean {
    const row = this.#db
      .prepare("SELECT 1 AS found FROM events WHERE source_fingerprint = ?")
      .get(sourceFingerprint);
    return row !== undefined;
  }

  size(): number {
    return Number((this.#db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n);
  }

  // -------------------------------------------------------------------------
  // Beyond the interface: what the read cursor needs
  // -------------------------------------------------------------------------

  /**
   * Events learned after a sequence number, oldest first.
   *
   * This — not `since()` — is what answers "what changed since I last checked". The difference
   * is the whole point of storing a sequence: `since()` asks when something happened, and a
   * pull request opened three days ago that the Companion first saw this morning is genuinely
   * new to the owner even though its timestamp is old.
   */
  afterSequence(seq: number, options: { projectId?: string; limit?: number } = {}): SequencedEvent[] {
    const clauses = ["seq > ?"];
    const params: (string | number)[] = [seq];
    if (options.projectId) {
      clauses.push("project_id = ?");
      params.push(options.projectId);
    }
    const limit = options.limit ? ` LIMIT ${Number(options.limit)}` : "";

    const rows = this.#db
      .prepare(`${SELECT} WHERE ${clauses.join(" AND ")} ORDER BY seq ASC${limit}`)
      .all(...params) as unknown as EventRow[];

    return rows.map((row) => ({ event: toEvent(row), seq: row.seq }));
  }

  /** The highest sequence stored, or 0 when the ledger is empty. */
  latestSequence(): number {
    const row = this.#db.prepare("SELECT MAX(seq) AS n FROM events").get() as { n: number | null };
    return Number(row.n ?? 0);
  }

  /** Most recent events first. What the feed reads when it does not want the whole history. */
  recent(options: { projectId?: string; limit?: number } = {}): CompanionEvent[] {
    const where = options.projectId ? " WHERE project_id = ?" : "";
    const params = options.projectId ? [options.projectId] : [];
    const limit = ` LIMIT ${Number(options.limit ?? 200)}`;

    const rows = this.#db
      .prepare(`${SELECT}${where} ORDER BY occurred_at DESC, seq DESC${limit}`)
      .all(...params) as unknown as EventRow[];

    return rows.map(toEvent).reverse();
  }
}
