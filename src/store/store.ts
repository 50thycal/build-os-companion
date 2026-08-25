/**
 * Everything durable that is not an event.
 *
 * Followed projects, per-project sync state, the latest artifact snapshots, the lifecycle of
 * each attention item, and the owner's read cursor.
 */

import type { AttentionItem, Severity } from "../domain/attention.ts";
import { needsOwner } from "../domain/attention.ts";
import type {
  BuildOsPaths,
  DecisionRecord,
  FollowedProject,
  IntegrityWarning,
  ProjectState,
  PullRequestState,
  SessionState,
  WorkstreamState,
} from "../domain/state.ts";
import type { SourceConflict } from "../domain/provenance.ts";
import type { Database } from "./database.ts";
import { transaction } from "./database.ts";

// ---------------------------------------------------------------------------
// Followed projects
// ---------------------------------------------------------------------------

interface ProjectRow {
  id: string;
  repository_full_name: string;
  owner_user_id: string;
  display_name: string | null;
  default_branch: string;
  build_os_detected: number;
  build_os_version: string | null;
  build_os_adopted_at: string | null;
  paths_json: string;
  enabled: number;
  created_at: string;
  last_synced_at: string | null;
  stale_since: string | null;
  last_error: string | null;
}

/** A followed project plus the operational state the sync loop keeps about it. */
export interface StoredProject extends FollowedProject {
  displayName?: string;
  lastError?: string;
}

function toProject(row: ProjectRow): StoredProject {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    repositoryFullName: row.repository_full_name,
    displayName: row.display_name ?? undefined,
    defaultBranch: row.default_branch,
    buildOsDetected: row.build_os_detected === 1,
    buildOsVersion: row.build_os_version ?? undefined,
    buildOsAdoptedAt: row.build_os_adopted_at ?? undefined,
    paths: JSON.parse(row.paths_json) as BuildOsPaths,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    lastSyncedAt: row.last_synced_at ?? undefined,
    staleSince: row.stale_since ?? undefined,
    lastError: row.last_error ?? undefined,
  };
}

export type SnapshotKind =
  | "workstreams"
  | "decisions"
  | "sessions"
  | "pullRequests"
  | "integrityWarnings"
  | "conflicts";

interface AttentionRow {
  id: string;
  project_id: string;
  entity_type: string;
  entity_id: string;
  severity: string;
  reason_code: string;
  reason_text: string;
  recommended_action: string;
  evidence_json: string;
  first_seen_at: string;
  first_seen_seq: number;
  last_seen_at: string;
  cleared_at: string | null;
  cleared_seq: number | null;
}

/** An attention item together with when it appeared and, if it has, when it stopped being true. */
export interface TrackedAttentionItem extends AttentionItem {
  firstSeenAt: string;
  firstSeenSeq: number;
  lastSeenAt: string;
  clearedAt?: string;
  clearedSeq?: number;
}

function toAttention(row: AttentionRow): TrackedAttentionItem {
  return {
    id: row.id,
    projectId: row.project_id,
    entityType: row.entity_type as AttentionItem["entityType"],
    entityId: row.entity_id,
    severity: row.severity as Severity,
    reasonCode: row.reason_code as AttentionItem["reasonCode"],
    reasonText: row.reason_text,
    recommendedAction: row.recommended_action,
    evidence: JSON.parse(row.evidence_json) as AttentionItem["evidence"],
    createdAt: row.first_seen_at,
    firstSeenAt: row.first_seen_at,
    firstSeenSeq: row.first_seen_seq,
    lastSeenAt: row.last_seen_at,
    clearedAt: row.cleared_at ?? undefined,
    clearedSeq: row.cleared_seq ?? undefined,
  };
}

export interface ReadCursor {
  ownerUserId: string;
  lastCheckedAt: string;
  lastSeq: number;
}

export class CompanionStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  get database(): Database {
    return this.#db;
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  /**
   * Insert or update a followed project, preserving its sync state.
   *
   * Deliberately does not touch `last_synced_at` or `stale_since`: re-reading the configuration
   * file on every boot must not reset how far each project has been synced, or every restart
   * would replay history.
   */
  upsertProject(project: StoredProject): void {
    this.#db
      .prepare(
        `INSERT INTO projects (
           id, repository_full_name, owner_user_id, display_name, default_branch,
           build_os_detected, build_os_version, build_os_adopted_at, paths_json, enabled,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           repository_full_name = excluded.repository_full_name,
           owner_user_id        = excluded.owner_user_id,
           display_name         = excluded.display_name,
           default_branch       = excluded.default_branch,
           build_os_detected    = excluded.build_os_detected,
           build_os_version     = excluded.build_os_version,
           build_os_adopted_at  = excluded.build_os_adopted_at,
           paths_json           = excluded.paths_json,
           enabled              = excluded.enabled`,
      )
      .run(
        project.id,
        project.repositoryFullName,
        project.ownerUserId,
        project.displayName ?? null,
        project.defaultBranch,
        project.buildOsDetected ? 1 : 0,
        project.buildOsVersion ?? null,
        project.buildOsAdoptedAt ?? null,
        JSON.stringify(project.paths),
        project.enabled ? 1 : 0,
        project.createdAt,
      );
  }

  listProjects(options: { includeDisabled?: boolean } = {}): StoredProject[] {
    const where = options.includeDisabled ? "" : " WHERE enabled = 1";
    return (
      this.#db.prepare(`SELECT * FROM projects${where} ORDER BY repository_full_name`).all() as unknown as ProjectRow[]
    ).map(toProject);
  }

  getProject(id: string): StoredProject | undefined {
    const row = this.#db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as unknown as
      | ProjectRow
      | undefined;
    return row ? toProject(row) : undefined;
  }

  /** Record the outcome of a sync cycle. A failure marks the project stale rather than erasing it. */
  recordSync(projectId: string, at: string, error?: string): void {
    if (error) {
      this.#db
        .prepare(
          `UPDATE projects SET last_error = ?, stale_since = COALESCE(stale_since, ?) WHERE id = ?`,
        )
        .run(error, at, projectId);
      return;
    }
    this.#db
      .prepare(`UPDATE projects SET last_synced_at = ?, stale_since = NULL, last_error = NULL WHERE id = ?`)
      .run(at, projectId);
  }

  // -------------------------------------------------------------------------
  // Artifact snapshots
  // -------------------------------------------------------------------------

  /**
   * Replace the stored artifact state for a project.
   *
   * These are not derived facts, they are the latest reading of a canonical source. The ledger
   * cannot stand in for them: workstream events are only emitted when something the normalizer
   * watches changes, so a workstream that gains an open decision without changing phase
   * produces no event at all and the newest snapshot in the ledger would still show the old
   * decision count. Storing the reading is what makes the Project view correct after a restart
   * with no sync.
   */
  putSnapshot(projectId: string, kind: SnapshotKind, value: unknown, at: string): void {
    this.#db
      .prepare(
        `INSERT INTO project_snapshots (project_id, kind, json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id, kind) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
      )
      .run(projectId, kind, JSON.stringify(value), at);
  }

  getSnapshot<T>(projectId: string, kind: SnapshotKind): T | undefined {
    const row = this.#db
      .prepare("SELECT json FROM project_snapshots WHERE project_id = ? AND kind = ?")
      .get(projectId, kind) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as T) : undefined;
  }

  /** Store every artifact-derived part of a project's state in one transaction. */
  putProjectState(state: ProjectState, at: string): void {
    transaction(this.#db, () => {
      this.putSnapshot(state.projectId, "workstreams", state.workstreams, at);
      this.putSnapshot(state.projectId, "decisions", state.decisions, at);
      this.putSnapshot(state.projectId, "sessions", state.sessions, at);
      this.putSnapshot(state.projectId, "pullRequests", state.pullRequests, at);
      this.putSnapshot(state.projectId, "integrityWarnings", state.integrityWarnings, at);
      this.putSnapshot(state.projectId, "conflicts", state.conflicts, at);
    });
  }

  /** Rebuild a project's state from what was last stored. Empty is a valid answer. */
  loadProjectState(projectId: string): ProjectState {
    return {
      projectId,
      pullRequests: this.getSnapshot<PullRequestState[]>(projectId, "pullRequests") ?? [],
      workstreams: this.getSnapshot<WorkstreamState[]>(projectId, "workstreams") ?? [],
      sessions: this.getSnapshot<SessionState[]>(projectId, "sessions") ?? [],
      decisions: this.getSnapshot<DecisionRecord[]>(projectId, "decisions") ?? [],
      integrityWarnings: this.getSnapshot<IntegrityWarning[]>(projectId, "integrityWarnings") ?? [],
      conflicts: this.getSnapshot<SourceConflict[]>(projectId, "conflicts") ?? [],
    };
  }

  // -------------------------------------------------------------------------
  // Attention lifecycle
  // -------------------------------------------------------------------------

  /**
   * Reconcile a freshly-computed attention list against what is already tracked.
   *
   * An item's id is deterministic — same situation, same id — which is what makes this a
   * lifecycle rather than a replace. An item present in both keeps its original `first_seen`,
   * so "this has been waiting on you since Tuesday" stays true. An item that has stopped being
   * produced is marked cleared rather than deleted, because "resolved since you last checked"
   * is a thing the owner needs told, and a deleted row cannot tell them.
   *
   * Only items that actually need the owner are tracked. The engine also emits severity `NONE`
   * suppressions to explain itself, and recording those would turn every healthy poll into
   * lifecycle churn.
   */
  reconcileAttention(
    projectId: string,
    items: AttentionItem[],
    at: string,
    seq: number,
  ): { opened: TrackedAttentionItem[]; resolved: TrackedAttentionItem[] } {
    const actionable = items.filter((item) => needsOwner(item.severity));
    const live = new Set(actionable.map((item) => item.id));

    return transaction(this.#db, () => {
      const existing = (
        this.#db
          .prepare("SELECT * FROM attention_items WHERE project_id = ?")
          .all(projectId) as unknown as AttentionRow[]
      ).map(toAttention);
      const byId = new Map(existing.map((item) => [item.id, item]));

      const opened: TrackedAttentionItem[] = [];

      for (const item of actionable) {
        const prior = byId.get(item.id);

        if (prior && !prior.clearedAt) {
          // Still true. Refresh the wording and severity, keep the clock running from when it
          // first appeared.
          this.#db
            .prepare(
              `UPDATE attention_items SET severity = ?, reason_text = ?, recommended_action = ?,
                 evidence_json = ?, last_seen_at = ? WHERE id = ?`,
            )
            .run(item.severity, item.reasonText, item.recommendedAction, JSON.stringify(item.evidence), at, item.id);
          continue;
        }

        // New, or the same situation recurring after being resolved. Either way it is something
        // the owner has not been told about, so the clock restarts.
        this.#db
          .prepare(
            `INSERT INTO attention_items (
               id, project_id, entity_type, entity_id, severity, reason_code, reason_text,
               recommended_action, evidence_json, first_seen_at, first_seen_seq, last_seen_at,
               cleared_at, cleared_seq
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
             ON CONFLICT(id) DO UPDATE SET
               severity = excluded.severity, reason_text = excluded.reason_text,
               recommended_action = excluded.recommended_action, evidence_json = excluded.evidence_json,
               first_seen_at = excluded.first_seen_at, first_seen_seq = excluded.first_seen_seq,
               last_seen_at = excluded.last_seen_at, cleared_at = NULL, cleared_seq = NULL`,
          )
          .run(
            item.id,
            projectId,
            item.entityType,
            item.entityId,
            item.severity,
            item.reasonCode,
            item.reasonText,
            item.recommendedAction,
            JSON.stringify(item.evidence),
            at,
            seq,
            at,
          );

        opened.push({ ...item, firstSeenAt: at, firstSeenSeq: seq, lastSeenAt: at });
      }

      const resolved: TrackedAttentionItem[] = [];
      for (const prior of existing) {
        if (prior.clearedAt || live.has(prior.id)) continue;
        this.#db
          .prepare("UPDATE attention_items SET cleared_at = ?, cleared_seq = ? WHERE id = ?")
          .run(at, seq, prior.id);
        resolved.push({ ...prior, clearedAt: at, clearedSeq: seq });
      }

      return { opened, resolved };
    });
  }

  /** Attention items that are currently true, most severe first. */
  openAttention(projectId?: string): TrackedAttentionItem[] {
    const where = projectId ? " AND project_id = ?" : "";
    const params = projectId ? [projectId] : [];
    return (
      this.#db
        .prepare(
          `SELECT * FROM attention_items WHERE cleared_at IS NULL${where}
           ORDER BY CASE severity
             WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2
             WHEN 'LOW' THEN 3 ELSE 4 END, first_seen_at ASC, id ASC`,
        )
        .all(...params) as unknown as AttentionRow[]
    ).map(toAttention);
  }

  /**
   * Items that first appeared after a moment and are still true. `undefined` means all of them.
   *
   * Keyed on time rather than on the event sequence, because attention is not always caused by
   * an event. A pull request goes stale because a threshold passed while nothing happened, so
   * the item opens on a sync that appended nothing and its recorded sequence is identical to
   * the cursor's. A `sequence >` comparison drops exactly those items — the ones that arrived
   * silently, which are the ones the owner most needs told about. The read cursor records when
   * the owner checked as well as how far, and this is what that timestamp is for.
   */
  attentionOpenedAfter(after?: string): TrackedAttentionItem[] {
    const rows = after
      ? this.#db
          .prepare(
            `SELECT * FROM attention_items WHERE first_seen_at > ? AND cleared_at IS NULL
             ORDER BY first_seen_at ASC, id ASC`,
          )
          .all(after)
      : this.#db
          .prepare(`SELECT * FROM attention_items WHERE cleared_at IS NULL ORDER BY first_seen_at ASC, id ASC`)
          .all();
    return (rows as unknown as AttentionRow[]).map(toAttention);
  }

  /** Items that stopped being true after a moment. `undefined` means all resolved items. */
  attentionResolvedAfter(after?: string): TrackedAttentionItem[] {
    const rows = after
      ? this.#db
          .prepare(
            `SELECT * FROM attention_items WHERE cleared_at > ? ORDER BY cleared_at ASC, id ASC`,
          )
          .all(after)
      : this.#db
          .prepare(`SELECT * FROM attention_items WHERE cleared_at IS NOT NULL ORDER BY cleared_at ASC, id ASC`)
          .all();
    return (rows as unknown as AttentionRow[]).map(toAttention);
  }

  // -------------------------------------------------------------------------
  // Read cursor
  // -------------------------------------------------------------------------

  /**
   * Where the owner has read up to.
   *
   * Absent means they have never marked anything read, which is different from having read
   * nothing — a fresh install should not present its entire backfill as breaking news, and
   * callers decide what to do with `undefined` rather than being handed a silent zero.
   */
  getReadCursor(ownerUserId: string): ReadCursor | undefined {
    const row = this.#db
      .prepare("SELECT * FROM read_cursor WHERE owner_user_id = ?")
      .get(ownerUserId) as { owner_user_id: string; last_checked_at: string; last_seq: number } | undefined;
    return row
      ? { ownerUserId: row.owner_user_id, lastCheckedAt: row.last_checked_at, lastSeq: Number(row.last_seq) }
      : undefined;
  }

  /**
   * Advance the read cursor. Only ever called from an explicit owner action.
   *
   * **Both dimensions are monotonic**, and that is not symmetry for its own sake. The cursor
   * records two different things — how far through the events the owner has read (`seq`), and
   * the moment the briefing they read was true as of (`at`) — because attention can change
   * without any event: a pull request goes stale when a threshold passes, so the item exists
   * only on the timestamp dimension.
   *
   * Guarding only the sequence therefore leaves the more fragile half open. A stale browser tab
   * re-submitting an older briefing would keep `seq` intact via `MAX` while dragging `at`
   * forward to the moment of the click, silently consuming every attention item that had
   * appeared in between — items that briefing never contained. Taking `MAX` of both means a
   * late submission of an old briefing is a no-op, which is what it should be.
   *
   * `at` is the moment the submitted briefing was *generated*, not the moment the button was
   * pressed. Those differ by however long the page sat open, and only the first is a claim
   * about what the owner actually saw.
   */
  markChecked(ownerUserId: string, seq: number, at: string): ReadCursor {
    this.#db
      .prepare(
        `INSERT INTO read_cursor (owner_user_id, last_checked_at, last_seq) VALUES (?, ?, ?)
         ON CONFLICT(owner_user_id) DO UPDATE SET
           last_checked_at = MAX(read_cursor.last_checked_at, excluded.last_checked_at),
           last_seq = MAX(read_cursor.last_seq, excluded.last_seq)`,
      )
      .run(ownerUserId, at, seq);
    return this.getReadCursor(ownerUserId)!;
  }
}
