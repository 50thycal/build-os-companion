/**
 * A sync cycle against durable storage.
 *
 * `syncProject` is unchanged and still does the work; this wraps it with the three things
 * persistence adds — where the last cycle got to, what state to keep when a cycle fails, and
 * how each attention item's lifecycle moves.
 */

import type { AttentionThresholds } from "../domain/attention.ts";
import type { CompanionEvent } from "../domain/events.ts";
import type {
  DecisionRecord,
  ProjectState,
  PullRequestState,
  SessionState,
  WorkstreamState,
} from "../domain/state.ts";
import { canDiscover, type GitHubPort } from "../ingest/github/client.ts";
import { discoverRepositories, windowStart, type DiscoveredRepository } from "../ingest/github/discovery.ts";
import { applyConfig, type CompanionConfig } from "../config/followed.ts";
import { SqliteEventLedger } from "../ledger/sqlite-ledger.ts";
import type { CompanionStore, StoredProject, TrackedAttentionItem } from "../store/store.ts";
import { syncProject } from "./sync-project.ts";

export interface DurableSyncInput {
  store: CompanionStore;
  ledger: SqliteEventLedger;
  github: GitHubPort;
  project: StoredProject;
  ownerLogin: string;
  now: Date;
  thresholds?: AttentionThresholds;
  sessions?: SessionState[];
  /** Floor for the first poll of a repository. See `SyncInput.backfillSince`. */
  backfillSince?: string;
}

export interface DurableSyncResult {
  projectId: string;
  appended: CompanionEvent[];
  duplicates: number;
  state: ProjectState;
  openedAttention: TrackedAttentionItem[];
  resolvedAttention: TrackedAttentionItem[];
  syncFailed?: string;
  /** Sequence after this cycle. What a briefing would mark read.  */
  sequence: number;
}

function indexBy<T, K>(items: T[], key: (item: T) => K): Map<K, T> {
  return new Map(items.map((item) => [key(item), item]));
}

export async function durableSync(input: DurableSyncInput): Promise<DurableSyncResult> {
  const { store, ledger, project, now } = input;
  const at = now.toISOString();

  // The previous projection comes from storage, which is what makes transition detection
  // survive a restart. Without it the first sync after a reboot looks like a first sync ever:
  // no previous draft state, so no "ready for review" is ever noticed.
  const previous = store.loadProjectState(project.id);

  const result = await syncProject({
    project,
    github: input.github,
    ledger,
    ownerLogin: input.ownerLogin,
    now,
    thresholds: input.thresholds,
    previousPullRequests: indexBy(previous.pullRequests, (pr) => pr.number),
    previousWorkstreams: indexBy(previous.workstreams, (ws) => ws.workstreamId),
    previousDecisions: indexBy(previous.decisions, (d) => d.decisionId),
    sessions: input.sessions ?? previous.sessions,
    backfillSince: input.backfillSince,
  });

  const sequence = ledger.latestSequence();

  if (result.syncFailed) {
    // Never overwrite good state with the empty state a failed poll produces. The owner sees
    // the last picture that was true, marked stale, rather than a project that appears to have
    // lost its workstreams.
    store.recordSync(project.id, at, result.syncFailed);

    const retained: ProjectState = {
      ...previous,
      projectId: project.id,
      // Pull requests still rebuild from the ledger, which the failure did not touch.
      pullRequests: result.state.pullRequests.length > 0 ? result.state.pullRequests : previous.pullRequests,
    };

    const { opened, resolved } = store.reconcileAttention(project.id, result.attention, at, sequence);
    return {
      projectId: project.id,
      appended: result.appended,
      duplicates: result.duplicates,
      state: retained,
      openedAttention: opened,
      resolvedAttention: resolved,
      syncFailed: result.syncFailed,
      sequence,
    };
  }

  // A successful poll that read no Build OS artifacts is not evidence they are gone — the
  // repository may simply not use Build OS, or a path may have moved. Keep what was there.
  const state: ProjectState = {
    ...result.state,
    workstreams: pickFresh(result.state.workstreams, previous.workstreams),
    decisions: pickFresh(result.state.decisions, previous.decisions),
  };

  // Persist what detection read, so the pin and its adoption boundary survive a restart. Without
  // this the served path would re-detect every cycle and still hold nothing between them, and a
  // failed cycle — which never reaches here — would silently drop the boundary.
  if (
    result.detected &&
    (result.detected.version !== project.buildOsVersion ||
      result.detected.adoptedAt !== project.buildOsAdoptedAt)
  ) {
    store.upsertProject({
      ...project,
      buildOsVersion: result.detected.version,
      buildOsAdoptedAt: result.detected.adoptedAt,
    });
  }

  store.putProjectState(state, at);
  store.recordSync(project.id, at);
  const { opened, resolved } = store.reconcileAttention(project.id, result.attention, at, sequence);

  return {
    projectId: project.id,
    appended: result.appended,
    duplicates: result.duplicates,
    state,
    openedAttention: opened,
    resolvedAttention: resolved,
    sequence,
  };
}

function pickFresh<T>(fresh: T[], previous: T[]): T[] {
  return fresh.length > 0 ? fresh : previous;
}

export interface SyncAllResult {
  results: DurableSyncResult[];
  sequence: number;
  /** What the discovery rule found this cycle, when it ran. */
  discovery?: DiscoveryOutcome;
}

export interface DiscoveryOutcome {
  repositories: DiscoveredRepository[];
  rejected: { fullName: string; reason: string }[];
  /** The start of the activity window, so the rule that was applied is reportable. */
  since: string;
  /** Set when discovery was attempted and could not answer. Nothing ages out on such a cycle. */
  failed?: string;
}

/**
 * Sync every enabled project.
 *
 * One project failing never stops the others: a repository the owner lost access to must not
 * take the whole application down with it.
 */
export async function syncAll(input: {
  store: CompanionStore;
  ledger: SqliteEventLedger;
  github: GitHubPort | ((project: StoredProject) => GitHubPort);
  ownerLogin: string;
  now: Date;
  thresholds?: AttentionThresholds;
  /**
   * The config, when the caller wants repository discovery run first. Absent, the followed set
   * is whatever storage already holds — which is what the tests and the demo want, and what a
   * caller with no discovering port gets anyway.
   */
  config?: CompanionConfig;
}): Promise<SyncAllResult> {
  const results: DurableSyncResult[] = [];
  const discovery = input.config ? await runDiscovery(input.store, input.config, input.github, input.now) : undefined;

  for (const project of input.store.listProjects()) {
    const github = typeof input.github === "function" ? input.github(project) : input.github;
    try {
      results.push(
        await durableSync({
          store: input.store,
          ledger: input.ledger,
          github,
          project,
          ownerLogin: input.ownerLogin,
          now: input.now,
          thresholds: input.thresholds,
          backfillSince: discovery?.since,
        }),
      );
    } catch (error) {
      input.store.recordSync(project.id, input.now.toISOString(), String(error));
      results.push({
        projectId: project.id,
        appended: [],
        duplicates: 0,
        state: input.store.loadProjectState(project.id),
        openedAttention: [],
        resolvedAttention: [],
        syncFailed: String(error),
        sequence: input.ledger.latestSequence(),
      });
    }
  }

  return { results, sequence: input.ledger.latestSequence(), discovery };
}

/**
 * Decide the followed set before syncing it.
 *
 * Ordered this way on purpose: a repository the owner started working in yesterday should appear
 * in today's feed with today's events, not one cycle late. The failure path is the important
 * one — when the listing cannot be read, `applyConfig` is still called so pins and overrides
 * apply, but `discoveryRan` stays false and nothing is aged out on the strength of an answer
 * nobody got.
 */
async function runDiscovery(
  store: CompanionStore,
  config: CompanionConfig,
  github: GitHubPort | ((project: StoredProject) => GitHubPort),
  now: Date,
): Promise<DiscoveryOutcome> {
  const since = windowStart(now, config.discovery.lookbackDays);
  const port = typeof github === "function" ? github(store.listProjects()[0] ?? placeholderProject(config, now)) : github;

  if (!config.discovery.enabled || !canDiscover(port)) {
    applyConfig(store, config, now);
    return {
      repositories: [],
      rejected: [],
      since,
      failed: config.discovery.enabled ? "this GitHub port cannot list repositories" : undefined,
    };
  }

  try {
    const result = await discoverRepositories({
      port,
      ownerLogin: config.ownerLogin,
      now,
      policy: {
        lookbackDays: config.discovery.lookbackDays,
        pinned: config.projects.map((entry) => entry.repository),
        excluded: config.discovery.exclude,
      },
    });
    applyConfig(store, config, now, { discovered: result.repositories, discoveryRan: true });
    return { repositories: result.repositories, rejected: result.rejected, since: result.since };
  } catch (error) {
    applyConfig(store, config, now);
    return { repositories: [], rejected: [], since, failed: String(error) };
  }
}

/** Enough of a project to build a client from, for the very first cycle of an empty database. */
function placeholderProject(config: CompanionConfig, now: Date): StoredProject {
  return {
    id: "discovery",
    ownerUserId: config.ownerLogin,
    repositoryFullName: `${config.ownerLogin}/discovery`,
    defaultBranch: "main",
    buildOsDetected: false,
    paths: { projectModel: "", decisions: "", activeWork: "", workstreamDir: "" },
    enabled: false,
    createdAt: now.toISOString(),
  };
}
