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
  /**
   * When this project adopted `buildOsVersion`. Work that predates it ran under the previous
   * version, and a later adoption never reaches back to judge it.
   */
  buildOsAdoptedAt?: string;
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
  headSha: string;
  baseBranch: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  mergeability: MergeabilityState;
  reviewState: ReviewState;
  ciState: CiState;
  /** Logins whose review is requested. Used to decide whether the *owner* is the blocker. */
  requestedReviewers: string[];
  /**
   * Full SHAs that an approving GitHub review named. GitHub stamps the commit id on the review
   * when it is submitted, so this is the one final-head authority that cannot be
   * self-referential — unlike a SHA written inside the commit it describes.
   */
  approvedHeadShas: string[];
  /**
   * Reviewers whose current position is `Changes required`. While this is non-empty the gate is
   * closed — one reviewer's approval never cancels another's outstanding objection.
   */
  changesRequestedBy: string[];
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

export const REVIEW_VERDICTS = [
  "NOT_STARTED",
  "IN_REVIEW",
  "CHANGES_REQUIRED",
  "APPROVED",
  "APPROVED_WITH_FOLLOW_UPS",
] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/** `Approved with follow-ups` clears the merge gate exactly as `Approved` does. */
export function isApprovingVerdict(verdict: ReviewVerdict | undefined): boolean {
  return verdict === "APPROVED" || verdict === "APPROVED_WITH_FOLLOW_UPS";
}

/**
 * One verdict, about one pull request.
 *
 * A workstream may span several PRs, and each is reviewed on its own. A single
 * workstream-level verdict compared against every linked PR reports an older merged PR as
 * unapproved the moment a newer one is approved — so a record always belongs to a PR.
 */
export interface ReviewRecord {
  /**
   * The PR this verdict is about. Resolved at reconcile time: a record that names no PR binds
   * to the workstream's most recent linked PR, which is the one under review in practice.
   */
  prNumber?: number;
  verdict?: ReviewVerdict;
  /**
   * The full 40-character SHA of the last commit reviewed in full. It is never the
   * finalization commit's own SHA — a commit cannot contain its own identity.
   */
  reviewedHead?: string;
  /**
   * The workstream declares the documentation-only merge-finalization commit pushed. The head
   * is then expected to be ahead of `reviewedHead`, and the final head is verified on the PR
   * itself rather than in this file.
   */
  finalized: boolean;
}

/**
 * Does the v0.5 merge gate apply to this workstream?
 *
 * Read from declared protocol metadata, never inferred from the presence of review fields: a
 * workstream that participates in v0.5 and then has its review record deleted must still be
 * covered, or the gate is opt-out by omission.
 */
export function participatesInReviewGate(version: string | undefined): boolean {
  if (!version) return false;
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 0 || minor >= 5;
}

/** The record covering one PR, or undefined when the workstream makes no claim about it. */
export function reviewRecordFor(
  records: ReviewRecord[],
  prNumber: number,
): ReviewRecord | undefined {
  return records.find((record) => record.prNumber === prNumber);
}

export interface OpenDecision {
  /** `D1`, `D2`… where the workstream file numbers them; otherwise a positional key. */
  key: string;
  /**
   * The decision itself, in one or two sentences — short enough to put on the Needs Me screen
   * verbatim without truncating mid-word.
   */
  question: string;
  /**
   * The complete text of the entry when it says more than `question` does: rationale, options,
   * and the implementer's recommendation. Absent when the entry was already a single sentence.
   * Nothing the artifact said is discarded; the split is about where it can be read, not what
   * is kept.
   */
  detail?: string;
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
  /**
   * From v0.5, one per reviewed PR. Empty on a workstream written under an earlier version —
   * absence is not an error, and a PR with no record here is a PR this workstream makes no
   * claim about.
   */
  reviewRecords: ReviewRecord[];
  /**
   * The Build OS version this workstream is run under, from its own `Build OS:` header or the
   * project's adopted version. It decides whether the v0.5 merge gate applies — **absence of a
   * review record must never be what makes a workstream look legacy**, or deleting the record
   * would delete the gate.
   */
  protocolVersion?: string;
  /**
   * Where `protocolVersion` came from. A version the workstream states itself is a declaration
   * about this workstream; one inherited from the project pin is a fact about the project, and
   * must not be read as a claim that historical work was done under it.
   */
  protocolVersionSource?: "WORKSTREAM" | "PROJECT";
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
  | "DUPLICATE_WORKSTREAM_ID"
  // v0.5 review gate
  | "REVIEW_VERDICT_MALFORMED"
  | "REVIEWED_HEAD_MALFORMED"
  | "APPROVED_WITHOUT_REVIEWED_HEAD"
  | "REVIEW_STALE"
  | "MERGED_WITHOUT_APPROVAL"
  | "WORKSTREAM_PR_STATE_MISMATCH"
  | "FINAL_HEAD_UNVERIFIED"
  | "REVIEW_RECORD_MISSING";

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
