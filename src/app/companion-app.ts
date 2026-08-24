/**
 * The application's read model.
 *
 * Every view in the web app goes through this object, and this object goes through the store
 * and the ledger. That is the architectural rule the whole design depends on: a screen never
 * reaches past it to GitHub, so there is exactly one interpretation of what is true and the
 * Feed, the Needs Me screen and the briefing cannot quietly disagree about it.
 *
 * Attention is read from storage rather than recomputed per request. The engine produced those
 * items at sync time and their lifecycle — when each first appeared, when it stopped being true
 * — is what the briefing reads. Recomputing here would let the Needs Me screen and the briefing
 * drift apart within one page load, which is precisely the kind of two-answers-to-one-question
 * problem the ledger exists to prevent.
 */

import type { AttentionThresholds } from "../domain/attention.ts";
import type { CompanionEvent } from "../domain/events.ts";
import type { ProjectState, PullRequestState, SessionState, WorkstreamState } from "../domain/state.ts";
import { buildFeed, rankFeed, type FeedCard } from "../feed/cards.ts";
import type { GitHubPort } from "../ingest/github/client.ts";
import { SqliteEventLedger } from "../ledger/sqlite-ledger.ts";
import type { CompanionStore, ReadCursor, StoredProject, TrackedAttentionItem } from "../store/store.ts";
import { syncAll, type SyncAllResult } from "../sync/durable-sync.ts";
import { buildFactPack, type FactPack } from "../briefing/fact-pack.ts";
import { buildSinceLastChecked, type SinceLastChecked } from "../briefing/since.ts";

/** How many events per project the feed considers. Ranking decides what surfaces. */
const FEED_EVENT_WINDOW = 300;

export interface ProjectView {
  project: StoredProject;
  state: ProjectState;
  attention: TrackedAttentionItem[];
  /** Workstreams still in play, most recently touched first. */
  activeWorkstreams: WorkstreamState[];
  completedWorkstreams: WorkstreamState[];
  openPullRequests: PullRequestState[];
  recentlyMergedPullRequests: PullRequestState[];
  /** Every unanswered decision across the project's workstreams. */
  openDecisions: { workstreamId: string; workstreamTitle: string; key: string; question: string; detail?: string }[];
  activeSessions: SessionState[];
  recentCards: FeedCard[];
}

export interface CompanionAppOptions {
  store: CompanionStore;
  ledger: SqliteEventLedger;
  ownerLogin: string;
  /** Built per project so each can carry its own credentials later. */
  github?: (project: StoredProject) => GitHubPort;
  thresholds?: AttentionThresholds;
  clock?: () => Date;
}

export class CompanionApp {
  readonly #store: CompanionStore;
  readonly #ledger: SqliteEventLedger;
  readonly #ownerLogin: string;
  readonly #github?: (project: StoredProject) => GitHubPort;
  readonly #thresholds?: AttentionThresholds;
  readonly #clock: () => Date;

  constructor(options: CompanionAppOptions) {
    this.#store = options.store;
    this.#ledger = options.ledger;
    this.#ownerLogin = options.ownerLogin;
    this.#github = options.github;
    this.#thresholds = options.thresholds;
    this.#clock = options.clock ?? (() => new Date());
  }

  get ownerLogin(): string {
    return this.#ownerLogin;
  }

  now(): Date {
    return this.#clock();
  }

  projects(): StoredProject[] {
    return this.#store.listProjects();
  }

  project(id: string): StoredProject | undefined {
    return this.#store.getProject(id);
  }

  /** Whether syncing is wired up at all. The UI hides the control rather than offering a dead button. */
  get canSync(): boolean {
    return this.#github !== undefined;
  }

  // -------------------------------------------------------------------------
  // Feed
  // -------------------------------------------------------------------------

  /**
   * Feed cards across every followed project.
   *
   * Built by the existing `buildFeed` from persisted events and persisted state — the same
   * function the CLI and the tests use. Cards are assembled per project because a card names
   * its project, then re-ranked together so the most important thing across everything the
   * owner follows is at the top.
   */
  feed(options: { projectId?: string; limit?: number } = {}): FeedCard[] {
    const now = this.now();
    const cards: FeedCard[] = [];

    for (const project of this.projects()) {
      if (options.projectId && project.id !== options.projectId) continue;

      const events = this.#ledger.recent({ projectId: project.id, limit: FEED_EVENT_WINDOW });
      if (events.length === 0) continue;

      cards.push(
        ...buildFeed({
          projectId: project.id,
          projectName: project.displayName ?? project.repositoryFullName,
          state: this.#store.loadProjectState(project.id),
          events,
          attention: this.#store.openAttention(project.id),
          now,
        }),
      );
    }

    const ranked = rankFeed(cards, now);
    return options.limit ? ranked.slice(0, options.limit) : ranked;
  }

  // -------------------------------------------------------------------------
  // Needs Me
  // -------------------------------------------------------------------------

  /**
   * Everything the attention engine says needs the owner, most severe first.
   *
   * An empty list is a real answer, and the screen is allowed to say so: only items at MEDIUM
   * or above are ever stored, so nothing is being hidden by a threshold applied here.
   */
  needsMe(projectId?: string): TrackedAttentionItem[] {
    return this.#store.openAttention(projectId);
  }

  /** The events behind an attention item's entity, so a classification can be inspected. */
  evidenceFor(item: TrackedAttentionItem, limit = 10): CompanionEvent[] {
    const events = this.#ledger.forProject(item.projectId);
    const prNumber = item.entityId.startsWith("pr:") ? Number(item.entityId.slice(3)) : undefined;

    return events
      .filter((event) => {
        if (prNumber !== undefined) return event.pullRequestNumber === prNumber;
        if (item.entityType === "WORKSTREAM") return event.workstreamId === item.entityId;
        if (item.entityType === "SESSION") return event.sessionId === item.entityId;
        return true;
      })
      .slice(-limit)
      .reverse();
  }

  // -------------------------------------------------------------------------
  // Project
  // -------------------------------------------------------------------------

  projectView(projectId: string): ProjectView | undefined {
    const project = this.#store.getProject(projectId);
    if (!project) return undefined;

    const state = this.#store.loadProjectState(projectId);
    const attention = this.#store.openAttention(projectId);

    const finished = (ws: WorkstreamState) =>
      ws.status === "COMPLETE" || ws.status === "ABANDONED" || ws.phase === "COMPLETE";

    const byRecency = (a: WorkstreamState, b: WorkstreamState) =>
      (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.workstreamId.localeCompare(b.workstreamId);

    return {
      project,
      state,
      attention,
      activeWorkstreams: state.workstreams.filter((ws) => !finished(ws)).sort(byRecency),
      completedWorkstreams: state.workstreams.filter(finished).sort(byRecency),
      openPullRequests: state.pullRequests
        .filter((pr) => pr.lifecycle === "OPEN" || pr.lifecycle === "DRAFT")
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      recentlyMergedPullRequests: state.pullRequests
        .filter((pr) => pr.lifecycle === "MERGED")
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 5),
      openDecisions: state.workstreams
        .filter((ws) => !finished(ws))
        .flatMap((ws) =>
          ws.openDecisions.map((d) => ({
            workstreamId: ws.workstreamId,
            workstreamTitle: ws.title,
            key: d.key,
            question: d.question,
            detail: d.detail,
          })),
        ),
      activeSessions: state.sessions.filter((s) => s.status === "ACTIVE" || s.status === "WAITING" || s.status === "BLOCKED"),
      recentCards: this.feed({ projectId, limit: 12 }),
    };
  }

  // -------------------------------------------------------------------------
  // Briefing and the read cursor
  // -------------------------------------------------------------------------

  since(projectId?: string): SinceLastChecked {
    return buildSinceLastChecked({
      store: this.#store,
      ledger: this.#ledger,
      ownerUserId: this.#ownerLogin,
      now: this.now(),
      projectId,
    });
  }

  briefing(projectId?: string): FactPack {
    return buildFactPack({
      store: this.#store,
      ledger: this.#ledger,
      ownerUserId: this.#ownerLogin,
      now: this.now(),
      projectId,
    });
  }

  readCursor(): ReadCursor | undefined {
    return this.#store.getReadCursor(this.#ownerLogin);
  }

  /**
   * Accept a briefing as read.
   *
   * Only ever called from an explicit owner action — a POST from the button on the briefing
   * page. Rendering the page does not call it, and neither does syncing, because a cursor that
   * advances because something drew a screen would silently consume the one piece of state the
   * owner is relying on.
   *
   * `checkpointAt` is the submitted briefing's `generatedAt`: what the owner saw, rather than
   * when they got round to pressing the button. Both are validated against the server rather
   * than trusted, because both arrive from a form:
   *
   * - a sequence above anything the ledger holds is **refused outright**. There is no
   *   legitimate way to produce one, and accepting it would mark events read before they
   *   existed — the cursor would sit ahead of the ledger and suppress everything until it
   *   caught up.
   * - a checkpoint in the future is **clamped to now** rather than refused, because a small
   *   clock difference between a phone and the server is ordinary and should not cost the
   *   owner their briefing.
   *
   * Returns `undefined` when the submission was refused, so a caller can tell the difference
   * between "marked" and "ignored".
   */
  markChecked(sequence: number, checkpointAt?: string): ReadCursor | undefined {
    const latest = this.#ledger.latestSequence();
    if (!Number.isFinite(sequence) || sequence < 0 || sequence > latest) return undefined;

    const now = this.now().toISOString();
    const parsed = checkpointAt ? Date.parse(checkpointAt) : Number.NaN;
    const at =
      Number.isNaN(parsed) || checkpointAt! > now ? now : new Date(parsed).toISOString();

    return this.#store.markChecked(this.#ownerLogin, sequence, at);
  }

  // -------------------------------------------------------------------------
  // Sync
  // -------------------------------------------------------------------------

  async sync(): Promise<SyncAllResult> {
    if (!this.#github) throw new Error("no GitHub client configured; set GITHUB_TOKEN");
    return syncAll({
      store: this.#store,
      ledger: this.#ledger,
      github: this.#github,
      ownerLogin: this.#ownerLogin,
      now: this.now(),
      thresholds: this.#thresholds,
    });
  }
}
