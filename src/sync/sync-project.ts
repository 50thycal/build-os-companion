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
  OperatingMode,
  ProjectState,
  PullRequestState,
  SessionState,
  WorkstreamState,
} from "../domain/state.ts";
import { computeAttention } from "../attention/engine.ts";
import { buildFeed, type FeedCard } from "../feed/cards.ts";
import { GitHubApiError, type GitHubPort } from "../ingest/github/client.ts";
import {
  normalizeBuildOsSyncFailure,
  normalizeGitHubObservation,
  normalizeSyncFailure,
} from "../ingest/github/normalize.ts";
import { detectBuildOs, workstreamFilePaths } from "../ingest/buildos/detect.ts";
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
  /**
   * How far back the *first* poll of a repository reaches.
   *
   * Once a repository has synced, `lastSyncedAt` is the cursor and a cycle costs one page. The
   * first cycle has no cursor, and without a floor it would walk a repository's entire pull
   * request history — several requests per pull request, across every newly discovered project,
   * in one cycle. The activity window is the honest bound: the feed is a picture of recent work,
   * so pull requests untouched in that window are not what the owner opened the app to see.
   */
  backfillSince?: string;
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
  /**
   * What this cycle detected about the project's Build OS adoption, when it read the artifacts.
   *
   * Returned rather than applied: `syncProject` does not own the project record. A caller that
   * persists projects stores this so the pin and its adoption date survive a restart; the CLI,
   * which detects for itself before calling, ignores it.
   */
  detected?: { version?: string; adoptedAt?: string; operatingMode?: OperatingMode };
}

async function loadBuildOsState(
  input: SyncInput,
): Promise<{
  workstreams: WorkstreamState[];
  decisions: DecisionRecord[];
  warnings: IntegrityWarning[];
  conflicts: ProjectState["conflicts"];
  detected: { version?: string; adoptedAt?: string; operatingMode?: OperatingMode };
} | undefined> {
  const { project, github, now } = input;
  if (!project.buildOsDetected) return undefined;

  const board = await github.readFile(project.repositoryFullName, project.paths.activeWork);
  if (!board) return undefined;

  const dirPaths = await github.listPaths(project.repositoryFullName, project.paths.workstreamDir);

  /**
   * Detect on every cycle, not once at configuration time.
   *
   * The project pin and its adoption date are read out of the repository's own agent
   * instructions, so a project that adopts v0.5 today must start being gated today — without
   * anyone re-running the CLI. Only the CLI used to detect, which left the served path, and so
   * the deployed path, holding no pin at all and the review gate inert on everything that did
   * not declare a version in its own header.
   */
  const instructions = await github.readFile(project.repositoryFullName, "CLAUDE.md");
  /**
   * Read only when there is no instructions file, so this costs one extra request for exactly
   * the repositories that would otherwise have no framework block at all — canonical Build OS
   * being the one that matters, since it keeps its block in `VERSION.md` and says so there.
   */
  const versionFile = instructions
    ? undefined
    : await github.readFile(project.repositoryFullName, "VERSION.md");
  const detection = detectBuildOs({
    paths: [...dirPaths, project.paths.activeWork],
    agentInstructions: instructions?.content,
    versionFile: versionFile?.content,
    overrides: project.paths,
  });
  // Detection reads the repository; the stored value is a memory of an earlier read. Prefer what
  // the artifacts say now, and fall back rather than forget when this cycle found nothing. The
  // date belongs to the version it was recorded against, so the two move together or not at all
  // — carrying an old adoption date onto a newly detected version would date the wrong boundary.
  const buildOsVersion = detection.version ?? project.buildOsVersion;
  const buildOsAdoptedAt = detection.version ? detection.adoptedAt : project.buildOsAdoptedAt;

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
    buildOsVersion,
    buildOsAdoptedAt,
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
    /**
     * The mode is not carried over from the stored project the way the pin is. It is cheap to
     * read, it is a live fact about the repository, and a remembered `solo` outliving the
     * declaration that produced it would keep a gate open that the project had closed.
     */
    detected: {
      version: buildOsVersion,
      adoptedAt: buildOsAdoptedAt,
      operatingMode: detection.operatingMode,
    },
  };
}

export async function syncProject(input: SyncInput): Promise<SyncResult> {
  const { project, github, ledger, now } = input;
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;

  let syncFailed: string | undefined;
  let detected: SyncResult["detected"];
  const appended: CompanionEvent[] = [];
  let duplicates = 0;

  // --- GitHub ------------------------------------------------------------
  try {
    const observation = await github.observe(project.repositoryFullName, {
      updatedSince: project.lastSyncedAt ?? input.backfillSince,
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
    /**
     * Best-effort, like the CI reads inside `observe()` — and for the same reason. A repository
     * whose GitHub pull-request data came through fine but whose Build OS artifacts could not be
     * read or parsed this cycle must not lose that pull-request data. Before this guard existed,
     * an error here propagated out of `syncProject` entirely: the whole cycle was recorded as
     * failed, `buildProjectState` never ran, and a pull request whose *event* had already been
     * appended to the ledger a moment earlier showed on the Feed as `No current state recorded.`
     * — a fact the sync actually knew, discarded by an unrelated failure.
     *
     * On failure, `workstreams`/`decisions` stay empty for this cycle exactly as they do when
     * the repository has no Build OS layer at all; `durableSync`'s `pickFresh` already retains
     * the previous good values rather than blanking them, so nothing is lost there either. The
     * failure itself is recorded as its own event rather than swallowed, so it can be seen and
     * acted on instead of the app quietly serving stale workstream state indefinitely.
     */
    try {
      const buildOs = await loadBuildOsState(input);
      if (buildOs) {
        workstreams = buildOs.workstreams;
        decisions = buildOs.decisions;
        warnings = buildOs.warnings;
        conflicts = buildOs.conflicts;
        detected = buildOs.detected;

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
    } catch (error) {
      const reason = error instanceof GitHubApiError ? error.message : String(error);
      const result = ledger.append(
        normalizeBuildOsSyncFailure(project.id, {
          repositoryFullName: project.repositoryFullName,
          observedAt: now.toISOString(),
          reason,
          statusCode: error instanceof GitHubApiError ? error.statusCode : undefined,
        }),
        now,
      );
      appended.push(...result.appended);
      duplicates += result.duplicates;
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
    buildOsAdoptedAt: detected?.adoptedAt ?? project.buildOsAdoptedAt,
    operatingMode: detected?.operatingMode,
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

  return { appended, duplicates, state, attention, cards, warnings, syncFailed, detected };
}
