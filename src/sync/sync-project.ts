/**
 * One sync cycle for one followed project.
 *
 * This is the seam where the whole architecture becomes visible: sources are observed,
 * normalized into the ledger, projected into state, judged by the attention engine, and only
 * then rendered. Nothing downstream of the ledger ever touches GitHub.
 */

import type { AttentionItem, AttentionThresholds } from "../domain/attention.ts";
import { DEFAULT_THRESHOLDS } from "../domain/attention.ts";
import type { CompanionEvent } from "../domain/events.ts";
import type {
  DecisionRecord,
  FollowedProject,
  IntegrityWarning,
  ProjectState,
  PullRequestState,
  SessionState,
  WorkstreamState,
} from "../domain/state.ts";
import { computeAttention } from "../attention/engine.ts";
import { buildFeed, type FeedCard } from "../feed/cards.ts";
import { GitHubApiError, type GitHubPort } from "../ingest/github/client.ts";
import { normalizeGitHubObservation, normalizeSyncFailure } from "../ingest/github/normalize.ts";
import { workstreamFilePaths } from "../ingest/buildos/detect.ts";
import { parseDecisions, toDecisionRecords } from "../ingest/buildos/parse.ts";
import { reconcileBuildOsState, type WorkstreamFileInput } from "../ingest/buildos/reconcile.ts";
import { normalizeDecisions, normalizeWorkstreams } from "../ingest/buildos/normalize.ts";
import { applyStaleness } from "../ingest/checkpoint/normalize.ts";
import { buildProjectState } from "../projection/project.ts";
import type { EventLedger } from "../ledger/ledger.ts";

export interface SyncInput {
  project: FollowedProject;
  github: GitHubPort;
  ledger: EventLedger;
  /** GitHub login of the owner, so "waiting on review" can mean "waiting on you". */
  ownerLogin: string;
  now: Date;
  thresholds?: AttentionThresholds;
  /** Previous projections, so transitions can be detected. Absent on first sync. */
  previousPullRequests?: Map<number, PullRequestState>;
  previousWorkstreams?: Map<string, WorkstreamState>;
  previousDecisions?: Map<string, DecisionRecord>;
  /** Live sessions from the checkpoint store. */
  sessions?: SessionState[];
  /** Feed window. */
  since?: string;
}

export interface SyncResult {
  appended: CompanionEvent[];
  duplicates: number;
  state: ProjectState;
  attention: AttentionItem[];
  cards: FeedCard[];
  warnings: IntegrityWarning[];
  /** Set when GitHub could not be reached. Previous state is retained, marked stale. */
  syncFailed?: string;
}

async function loadBuildOsState(
  input: SyncInput,
): Promise<{
  workstreams: WorkstreamState[];
  decisions: DecisionRecord[];
  warnings: IntegrityWarning[];
  conflicts: ProjectState["conflicts"];
} | undefined> {
  const { project, github, now } = input;
  if (!project.buildOsDetected) return undefined;

  const board = await github.readFile(project.repositoryFullName, project.paths.activeWork);
  if (!board) return undefined;

  const dirPaths = await github.listPaths(project.repositoryFullName, project.paths.workstreamDir);
  const files: WorkstreamFileInput[] = [];

  for (const path of workstreamFilePaths(project.paths, dirPaths)) {
    const file = await github.readFile(project.repositoryFullName, path);
    if (file) {
      files.push({ path, markdown: file.content, commitSha: file.sha, htmlUrl: file.htmlUrl });
    }
  }

  const reconciled = reconcileBuildOsState(project.id, {
    activeBoardPath: project.paths.activeWork,
    activeBoardMarkdown: board.content,
    activeBoardCommitSha: board.sha,
    activeBoardHtmlUrl: board.htmlUrl,
    workstreamFiles: files,
    observedAt: now.toISOString(),
  });

  const decisionsFile = await github.readFile(project.repositoryFullName, project.paths.decisions);
  const decisions = decisionsFile
    ? toDecisionRecords(
        project.id,
        project.paths.decisions,
        parseDecisions(decisionsFile.content),
        decisionsFile.htmlUrl,
      )
    : [];

  return {
    workstreams: reconciled.workstreams,
    decisions,
    warnings: reconciled.warnings,
    conflicts: reconciled.conflicts,
  };
}

export async function syncProject(input: SyncInput): Promise<SyncResult> {
  const { project, github, ledger, now } = input;
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;

  let syncFailed: string | undefined;
  const appended: CompanionEvent[] = [];
  let duplicates = 0;

  // --- GitHub ------------------------------------------------------------
  try {
    const observation = await github.observe(project.repositoryFullName, {
      updatedSince: project.lastSyncedAt,
    });
    const result = ledger.append(
      normalizeGitHubObservation(observation, {
        projectId: project.id,
        previous: input.previousPullRequests,
      }),
      now,
    );
    appended.push(...result.appended);
    duplicates += result.duplicates;
  } catch (error) {
    // Never erase state on a failed poll. Record the failure and keep the last good picture.
    syncFailed = error instanceof GitHubApiError ? error.message : String(error);
    const result = ledger.append(
      normalizeSyncFailure(project.id, {
        repositoryFullName: project.repositoryFullName,
        observedAt: now.toISOString(),
        reason: syncFailed,
        statusCode: error instanceof GitHubApiError ? error.statusCode : undefined,
      }),
      now,
    );
    appended.push(...result.appended);
    duplicates += result.duplicates;
  }

  // --- Build OS ----------------------------------------------------------
  let workstreams: WorkstreamState[] = [];
  let decisions: DecisionRecord[] = [];
  let warnings: IntegrityWarning[] = [];
  let conflicts: ProjectState["conflicts"] = [];

  if (!syncFailed) {
    const buildOs = await loadBuildOsState(input);
    if (buildOs) {
      workstreams = buildOs.workstreams;
      decisions = buildOs.decisions;
      warnings = buildOs.warnings;
      conflicts = buildOs.conflicts;

      const wsResult = ledger.append(
        normalizeWorkstreams(workstreams, {
          projectId: project.id,
          previous: input.previousWorkstreams,
        }),
        now,
      );
      const decisionResult = ledger.append(
        normalizeDecisions(decisions, {
          projectId: project.id,
          previous: input.previousDecisions,
          observedAt: now.toISOString(),
        }),
        now,
      );
      appended.push(...wsResult.appended, ...decisionResult.appended);
      duplicates += wsResult.duplicates + decisionResult.duplicates;
    }
  }

  // --- Sessions ----------------------------------------------------------
  const sessions = applyStaleness(input.sessions ?? [], now, thresholds);

  // --- Project state, attention, feed -------------------------------------
  const events = ledger.forProject(project.id);
  const state = buildProjectState({
    projectId: project.id,
    events,
    workstreams,
    sessions,
    decisions,
    integrityWarnings: warnings,
    conflicts,
  });

  const attention = computeAttention({
    state,
    ownerLogin: input.ownerLogin,
    now,
    thresholds,
    recentEvents: appended,
  });

  const cards = buildFeed({
    projectId: project.id,
    projectName: project.repositoryFullName,
    state,
    events,
    attention,
    now,
    since: input.since,
  });

  return { appended, duplicates, state, attention, cards, warnings, syncFailed };
}
