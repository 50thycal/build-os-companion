/**
 * Materialized current state.
 *
 * These are projections: rebuilt from the ledger, never edited in place. If a projection and
 * the ledger disagree, the ledger is right and the projection is stale.
 */

import type { SourceConflict, SourceRef } from "./provenance.ts";

/** A repository the owner follows. */
export interface FollowedProject {
  id: string;
  ownerUserId: string;
  repositoryFullName: string;
  githubRepositoryId?: number;
  defaultBranch: string;
  buildOsDetected: boolean;
  buildOsVersion?: string;
  /** Resolved paths, honouring per-repository overrides. */
  paths: BuildOsPaths;
  enabled: boolean;
  createdAt: string;
  lastSyncedAt?: string;
  /** Set when the last sync failed; state is retained and marked stale rather than erased. */
  staleSince?: string;
}

export interface BuildOsPaths {
  projectModel: string;
  decisions: string;
  activeWork: string;
  /** Directory containing `WS-###-*.md`. */
  workstreamDir: string;
}

export const DEFAULT_BUILD_OS_PATHS: BuildOsPaths = {
  projectModel: "docs/PROJECT_MODEL.md",
  decisions: "docs/DECISIONS.md",
  activeWork: "docs/workstreams/ACTIVE.md",
  workstreamDir: "docs/workstreams",
};

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

export type PullRequestLifecycle = "OPEN" | "DRAFT" | "MERGED" | "CLOSED";
export type ReviewState = "NONE" | "REVIEW_REQUESTED" | "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED";
export type CiState = "NONE" | "PENDING" | "RUNNING" | "PASSED" | "FAILED";
export type MergeabilityState = "UNKNOWN" | "CLEAN" | "BLOCKED" | "CONFLICTED";

export interface PullRequestState {
  projectId: string;
  number: number;
  title: string;
  lifecycle: PullRequestLifecycle;
  draft: boolean;
  headBranch: string;
  baseBranch: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  mergeability: MergeabilityState;
  reviewState: ReviewState;
  ciState: CiState;
  /** Logins whose review is requested. Used to decide whether the *owner* is the blocker. */
  requestedReviewers: string[];
  /** Many-to-many: a PR may serve several workstreams. Never collapse this to one field. */
  workstreamIds: string[];
  summary?: string;
  sourceUrl: string;
  source: SourceRef;
}

// ---------------------------------------------------------------------------
// Build OS workstreams
// ---------------------------------------------------------------------------

export const WORKSTREAM_PHASES = [
  "IDEA",
  "EXPLORE",
  "MODEL",
  "DECIDE",
  "BUILD_CARD",
  "READY_TO_BUILD",
  "BUILDING",
  "REVIEW",
  "COMPLETE",
] as const;
export type WorkstreamPhase = (typeof WORKSTREAM_PHASES)[number];

export const WORKSTREAM_STATUSES = ["ACTIVE", "PAUSED", "BLOCKED", "ABANDONED", "COMPLETE"] as const;
export type WorkstreamStatus = (typeof WORKSTREAM_STATUSES)[number];

export interface OpenDecision {
  /** `D1`, `D2`… where the workstream file numbers them; otherwise a positional key. */
  key: string;
  question: string;
}

export interface WorkstreamState {
  projectId: string;
  workstreamId: string;
  title: string;
  /** Absent means the parser could not read it confidently. It never guesses. */
  phase?: WorkstreamPhase;
  status?: WorkstreamStatus;
  goal?: string;
  nextStep?: string;
  /** Build OS records a blocker as BLOCKED status plus the reason in Next Step. */
  blocker?: string;
  openDecisions: OpenDecision[];
  relatedPrNumbers: number[];
  relatedDecisionIds: string[];
  buildCardReady: boolean;
  implementationState?: string;
  reviewState?: string;
  updatedAt?: string;
  sourcePath: string;
  source: SourceRef;
  /** Populated when ACTIVE.md and the workstream file disagree. */
  conflicts: SourceConflict[];
}

// ---------------------------------------------------------------------------
// Agent sessions
// ---------------------------------------------------------------------------

export type SessionKind = "DESIGN" | "IMPLEMENTATION" | "REVIEW" | "INVESTIGATION" | "OPERATIONS";

/**
 * `UNKNOWN` is assigned by the Companion to a session that stopped checkpointing. An agent may
 * never claim it — see the checkpoint contract. Silence is never `COMPLETED`.
 */
export type SessionStatus = "ACTIVE" | "WAITING" | "BLOCKED" | "COMPLETED" | "ABANDONED" | "UNKNOWN";

export interface SessionBlocker {
  description: string;
  needsOwner: boolean;
}

export interface SessionState {
  projectId: string;
  sessionId: string;
  workstreamId?: string;
  agent: string;
  agentName?: string;
  sessionKind: SessionKind;
  objective: string;
  phase?: WorkstreamPhase;
  status: SessionStatus;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  relatedPrNumber?: number;
  completed: string[];
  inProgress: string[];
  blockers: SessionBlocker[];
  nextStep?: string;
  /** `GITHUB` for a committed checkpoint, `API` for an ephemeral one. Drives how it is shown. */
  checkpointSource: "GITHUB" | "API";
  /** True once the staleness sweep has demoted this session. */
  stale: boolean;
}

// ---------------------------------------------------------------------------
// Build OS decisions
// ---------------------------------------------------------------------------

export type DecisionStatus = "PROPOSED" | "ACCEPTED" | "SUPERSEDED" | "DEPRECATED";

export interface DecisionRecord {
  projectId: string;
  decisionId: string;
  title: string;
  date?: string;
  status: DecisionStatus;
  supersededBy?: string;
  sourcePath: string;
  sourceUrl?: string;
}

// ---------------------------------------------------------------------------
// Integrity
// ---------------------------------------------------------------------------

export type IntegrityCode =
  | "BOARD_FILE_PHASE_MISMATCH"
  | "BOARD_FILE_STATUS_MISMATCH"
  | "WORKSTREAM_MISSING_FROM_BOARD"
  | "BOARD_ROW_WITHOUT_FILE"
  | "WORKSTREAM_ID_FILENAME_MISMATCH"
  | "COMPLETED_WORKSTREAM_STILL_ACTIVE"
  | "DUPLICATE_WORKSTREAM_ID";

/**
 * A problem with the *project's* Build OS records, addressed to its owner. Not a parser error:
 * integrity warnings never stop the rest of the parse.
 */
export interface IntegrityWarning {
  code: IntegrityCode;
  workstreamId?: string;
  message: string;
  sources: SourceRef[];
}

// ---------------------------------------------------------------------------
// Whole-project projection
// ---------------------------------------------------------------------------

export interface ProjectState {
  projectId: string;
  pullRequests: PullRequestState[];
  workstreams: WorkstreamState[];
  sessions: SessionState[];
  decisions: DecisionRecord[];
  integrityWarnings: IntegrityWarning[];
  conflicts: SourceConflict[];
}
