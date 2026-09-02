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
  /**
   * When the pull request merged, and when it closed. Absent while it is open.
   *
   * Carried because "merged" is not only a lifecycle value, it is a *moment*, and the owner
   * reading a card after a day away needs the moment. Without these the only thing a merged
   * pull request could say about itself was its pre-merge review and CI state — which is how a
   * merged PR came to report "no review yet" as though review were still pending.
   */
  mergedAt?: string;
  closedAt?: string;
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
   * Owner acceptances recorded on the PR as comment verdicts (v0.8).
   *
   * Deliberately **not** merged into `approvedHeadShas`. An acceptance is evidence that the owner
   * took responsibility for work nobody reviewed; folding it in would make every existing check
   * read it as a review, which is the one thing the verdict exists to prevent. Whether it can
   * clear a gate is the review gate's question, because only there is the project's operating
   * mode known.
   */
  ownerAcceptances: OwnerAcceptance[];
  /**
   * How many current review positions of any kind this PR carries — reviews and comment verdicts
   * together, approving or objecting, gate-clearing or not.
   *
   * Exists for one question: does anything outside the workstream file record a verdict at all?
   * A count of *any* position rather than of matching ones is deliberate. A real approval that
   * cannot clear the gate — one naming no actor, say — is still evidence that a review happened,
   * and calling the file's claim unsupported because of it would be a serious accusation made on
   * a technicality.
   */
  recordedPositions: number;
  /**
   * Reviewers whose current position is `Changes required`. While this is non-empty the gate is
   * closed — one reviewer's approval never cancels another's outstanding objection.
   */
  changesRequestedBy: Objection[];
  /**
   * Verdict evidence on this PR that was altered after it was given.
   *
   * A verdict is supposed to be a statement about one commit, fixed at the moment it was made.
   * A pull request comment is editable and the PR body is editable, so evidence *can* move
   * while the commit it names stays put. Where that happened it is recorded here and the
   * evidence stops clearing the gate — reported rather than resolved, because which side
   * changed is not knowable from the outside.
   */
  mutatedEvidence: string[];
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

/**
 * An outstanding `Changes required`, and who it came from.
 *
 * Two names rather than one, because in a single-account repository they are different things:
 * several actors share one GitHub login, so the login says how the objection arrived, not who
 * raised it. Collapsing them loses exactly the provenance the review gate exists to keep — two
 * objections relayed through one account would read as one reviewer repeating themselves.
 */
export interface Objection {
  /**
   * Who raised it, when the record says. A GitHub review's actor is its login, because GitHub
   * authenticated it. A comment verdict's is whatever the comment declared; absent when it
   * declared none, which is also why it could not have cleared the gate.
   */
  actor?: string;
  /** The GitHub account that carried it. Transport, never identity. */
  author: string;
}

/** How an objection reads to a person: the actor where known, and the pipe it came down. */
export function objectionLabel(objection: Objection): string {
  if (!objection.actor) return objection.author;
  return objection.actor === objection.author
    ? objection.actor
    : `${objection.actor} (via ${objection.author})`;
}

/**
 * Whether an independent actor exists to review this project's work (Build OS v0.8).
 *
 * `reviewed` is the default and what an absent declaration means. `solo` is a project stating
 * that it has no second party — one person, one identity, one agent — so acceptance comes from
 * the owner instead of a reviewer. It is a disclosure, not a licence: a `solo` project still
 * records who accepted what at which commit, and never describes accepted work as reviewed.
 *
 * **Declared, never inferred.** A project is not `solo` because its PRs happen to lack reviews.
 */
/**
 * The owner accepting a change no independent party reviewed, as recorded on a pull request.
 *
 * Carries its prose because a **relayed** acceptance — one an agent transcribed from a decision
 * the owner gave elsewhere — is identical in every field to one the owner posted, and differs
 * only in those words. Dropping them would leave the two indistinguishable, which is precisely
 * the distinction the relay form was written to preserve.
 */
export interface OwnerAcceptance {
  /** The GitHub account that carried it. Transport, never identity. */
  author: string;
  /** Who accepted, as the comment declared. Absent means the acceptance cannot clear a gate. */
  actor?: string;
  /** Lowercased full SHA the acceptance named, from its own `Accepted head:` field. */
  head?: string;
  /** What the comment said beneath the fields — where a relay discloses that it is one. */
  note?: string;
  at: string;
}

export const OPERATING_MODES = ["reviewed", "solo"] as const;
export type OperatingMode = (typeof OPERATING_MODES)[number];

export function normalizeOperatingMode(text: string | undefined): OperatingMode | undefined {
  if (text === undefined) return undefined;
  const cleaned = text.replace(/[*`]/g, "").trim().toLowerCase();
  return (OPERATING_MODES as readonly string[]).includes(cleaned)
    ? (cleaned as OperatingMode)
    : undefined;
}

export const REVIEW_VERDICTS = [
  "NOT_STARTED",
  "IN_REVIEW",
  "CHANGES_REQUIRED",
  "APPROVED",
  "APPROVED_WITH_FOLLOW_UPS",
  /**
   * v0.8. The owner accepted work that **no independent party reviewed**, in a project that has
   * declared no independent party exists. That is a true statement and a much weaker one than
   * `APPROVED`, which is why it is a verdict of its own rather than a flag on that one.
   */
  "OWNER_ACCEPTED",
] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/**
 * `Approved with follow-ups` clears the merge gate exactly as `Approved` does.
 *
 * `Owner-accepted` deliberately does **not**, and this is the function that keeps it out. The
 * parse contract is explicit: a consumer must never treat an acceptance as an approval, because
 * ranking them together or letting one satisfy a check written for the other destroys the only
 * distinction the verdict carries. Where an acceptance may stand in for an approval — the merge
 * gate of a project operating in `solo` mode — the caller asks the other question below.
 */
export function isApprovingVerdict(verdict: ReviewVerdict | undefined): boolean {
  return verdict === "APPROVED" || verdict === "APPROVED_WITH_FOLLOW_UPS";
}

/**
 * Verdicts that can let a PR merge **in a `solo` project**: an approval, or the owner accepting.
 *
 * Only ever correct behind an explicit `solo` check. In a `reviewed` project an `Owner-accepted`
 * is a contradiction to report, not a gate to open — the mode says a reviewer was available, so
 * their absence is a missing review rather than a substitute for one.
 */
export function isAcceptingVerdict(verdict: ReviewVerdict | undefined): boolean {
  return isApprovingVerdict(verdict) || verdict === "OWNER_ACCEPTED";
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
   * The head an `Owner-accepted` verdict names (v0.8).
   *
   * A **separate field** from `reviewedHead`, and deliberately so: nothing was reviewed, so
   * borrowing the reviewed field would erase the distinction the verdict exists to preserve —
   * and would silently turn every acceptance into an approval for any check that reads only the
   * one field. Same format rules; an abbreviation proves nothing here either.
   */
  acceptedHead?: string;
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
  // v0.8 operating modes, v0.10 unsupported verdicts
  | "ACCEPTED_HEAD_MALFORMED"
  | "OWNER_ACCEPTED_IN_REVIEWED_MODE"
  | "VERDICT_UNSUPPORTED"
  | "REVIEW_STALE"
  | "MERGED_WITHOUT_APPROVAL"
  | "WORKSTREAM_PR_STATE_MISMATCH"
  | "FINAL_HEAD_UNVERIFIED"
  | "REVIEW_RECORD_MISSING"
  | "REVIEW_EVIDENCE_MUTATED"
  // Durable record versus observed reality
  | "WORKSTREAM_STATE_BEHIND_GITHUB"
  | "BLOCKER_ALREADY_RESOLVED";

/**
 * How loudly an integrity finding should be said.
 *
 * The distinction is which kind of disagreement it is. A **bookkeeping** finding is one source
 * being untidy — a board row out of step with its own workstream file, a malformed field — and
 * it is the owner's to tidy when convenient. A **reconciliation** finding is the durable record
 * and GitHub telling the owner two different things about the same work, which is the single
 * most valuable output this application has and belongs on `Needs Me`.
 *
 * That distinction did not exist before: every finding was folded into one `LOW` project-level
 * item, and `Needs Me` shows `MEDIUM` and above. A contradiction between the layers was
 * therefore structurally incapable of reaching the screen it was for.
 */
export function integritySeverity(code: IntegrityCode): "HIGH" | "MEDIUM" | "LOW" {
  switch (code) {
    // The v0.5 gate was breached, or its evidence cannot be trusted. Nothing outranks this.
    case "MERGED_WITHOUT_APPROVAL":
    case "REVIEW_EVIDENCE_MUTATED":
    /**
     * The durable record claims a verdict that nothing outside it records.
     *
     * As serious as mutated evidence and for the same reason: the file is asserting a review
     * that may never have happened. Its commonest cause is a finalization commit pre-writing the
     * verdict it expected to receive, which the protocol forbids precisely because the value
     * then survives whether or not the review it anticipates ever arrives.
     */
    case "VERDICT_UNSUPPORTED":
      return "HIGH";
    // The two layers disagree, or the gate is open and unsatisfied.
    case "WORKSTREAM_PR_STATE_MISMATCH":
    case "WORKSTREAM_STATE_BEHIND_GITHUB":
    case "BLOCKER_ALREADY_RESOLVED":
    case "REVIEW_STALE":
    case "FINAL_HEAD_UNVERIFIED":
    case "REVIEW_RECORD_MISSING":
    case "APPROVED_WITHOUT_REVIEWED_HEAD":
    // The project says a reviewer was available and the record says the owner accepted instead.
    // Treated as a missing review, which is what it is.
    case "OWNER_ACCEPTED_IN_REVIEWED_MODE":
      return "MEDIUM";
    // One source being untidy about itself.
    default:
      return "LOW";
  }
}

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
