/**
 * Deriving PR state from an observation.
 *
 * Kept separate from event normalization because these are pure classification rules that both
 * the normalizer and the projection need, and because they are the part most likely to be wrong
 * in interesting ways.
 */

import type {
  CiState,
  MergeabilityState,
  PullRequestLifecycle,
  PullRequestState,
  ReviewState,
} from "../../domain/state.ts";
import type { SourceRef } from "../../domain/provenance.ts";
import type { GitHubPullRequestObservation } from "./types.ts";
import { commentVerdicts, implementationActor } from "./comment-verdict.ts";
import { isApprovingVerdict } from "../../domain/state.ts";

export function deriveLifecycle(pr: GitHubPullRequestObservation): PullRequestLifecycle {
  if (pr.merged) return "MERGED";
  if (pr.state === "closed") return "CLOSED";
  if (pr.draft) return "DRAFT";
  return "OPEN";
}

/**
 * The latest non-dismissed review per reviewer decides. An approval after a
 * changes-requested clears it; a changes-requested after an approval reinstates it.
 *
 * `PENDING` reviews are drafts the reviewer has not submitted and are ignored entirely.
 */
/**
 * The latest review each reviewer actually stands behind.
 *
 * `DISMISSED` reviews were explicitly retracted; `PENDING` ones were never submitted. What
 * remains, newest per reviewer, is the set of live opinions — which is the only set a gate may
 * reason about. A reviewer who approved and then requested changes has one current position, not
 * two, and the historical union of every `APPROVED` review would silently keep the old one alive.
 */
interface Position {
  /** The GitHub account that carried the position. Transport, not identity. */
  author: string;
  /**
   * Who took the position, when the artifact says.
   *
   * A GitHub review's actor *is* its login — GitHub authenticated it. A comment verdict's is
   * whatever the comment declared, because the login there is only the pipe it came down.
   */
  actor?: string;
  at: string;
  approving: boolean;
  changesRequested: boolean;
  /** The commit the position was taken against, when one is recorded. */
  head?: string;
  /**
   * Whether this position may open the merge gate.
   *
   * False for a comment verdict that named no actor, and for one whose actor is the same actor
   * the PR says implemented it. Both are still positions — they displace an earlier one by the
   * same actor, and an objection still closes the gate — they simply cannot be the evidence that
   * a merge was independently approved.
   */
  gateClearing: boolean;
}

/**
 * Positions are keyed on the actor where one is known, and only otherwise on the login.
 *
 * This is the single-account case the comment form exists for: an owner, an implementation agent
 * and an independent reviewer can all post as one login. Keying on the login alone makes them
 * one reviewer, so the last one to speak silently overwrites the others — an implementation
 * agent's position could supersede an independent reviewer's for no reason but sharing a pipe.
 */
function positionKey(position: Position): string {
  return position.actor ?? position.author;
}

function activePositions(pr: GitHubPullRequestObservation): { positions: Position[]; mutations: string[] } {
  const latestByReviewer = new Map<string, Position>();
  const implementedBy = implementationActor(pr.body);
  /** Evidence that changed after the fact. Reported; never silently resolved. */
  const mutations: string[] = [];

  const consider = (position: Position): void => {
    const key = positionKey(position);
    const existing = latestByReviewer.get(key);
    if (!existing || position.at > existing.at) latestByReviewer.set(key, position);
  };

  for (const review of pr.reviews) {
    if (review.state === "DISMISSED" || review.state === "PENDING") continue;
    // COMMENTED does not change a reviewer's verdict, so it must not displace one.
    if (review.state === "COMMENTED") continue;
    consider({
      author: review.author,
      at: review.submittedAt,
      approving: review.state === "APPROVED",
      changesRequested: review.state === "CHANGES_REQUESTED",
      head: review.commitId,
      // GitHub authenticated this one, and refuses it on a PR the account authored — so a review
      // that exists at all is already someone other than the author.
      gateClearing: true,
    });
  }

  /**
   * A comment carrying an explicit verdict is a position of the same standing as a review.
   *
   * It has to be, or the gate is unsatisfiable wherever GitHub refuses the review artifact — a
   * repository worked by one account, which is every project this was built for. It is not the
   * `COMMENTED` case above: that is a review deliberately withholding a verdict, whereas this
   * one states a verdict in a form nothing writes by accident.
   *
   * Merged into the same per-author map on purpose. A reviewer who approves in a review and
   * later objects in a comment has one current position, not two, and whichever came last is it.
   */
  for (const position of commentVerdicts(pr.comments)) {
    /**
     * Independence is established by the record, immutably, or not at all.
     *
     * A comment verdict opens the gate only when it names an actor, names the implementation
     * actor **inside itself**, and the two differ. The pair has to travel in the artifact: the
     * PR body is editable and its head does not move when it changes, so comparing against the
     * body's *current* declaration would let a self-review become independent after the fact —
     * post a non-clearing verdict, edit the body to name a different implementer, and the old
     * comment silently starts clearing the gate.
     */
    const reviewed = position.reviewedImplementationActor;
    const independent =
      position.actor !== undefined &&
      reviewed !== undefined &&
      position.actor.toLowerCase() !== reviewed.toLowerCase();

    /**
     * The body is still worth reading — as a cross-check, never as the authority.
     *
     * Where the verdict's captured implementer and the PR's current declaration disagree, one of
     * them changed after the review. Which one is not knowable from here, so this fails closed
     * and reports rather than picking a side.
     */
    const contradicted =
      reviewed !== undefined &&
      implementedBy !== undefined &&
      reviewed.toLowerCase() !== implementedBy.toLowerCase();

    if (contradicted) {
      mutations.push(
        `A verdict by ${position.actor ?? position.author} reviewed implementation actor ` +
          `"${reviewed}", but this pull request now declares "${implementedBy}". One of them ` +
          `changed after the review; the verdict does not clear the gate.`,
      );
    }
    if (position.edited && isApprovingVerdict(position.verdict)) {
      mutations.push(
        `An approving verdict by ${position.actor ?? position.author} was edited after it was ` +
          `posted, so it cannot be evidence of what was approved. Post a new comment instead.`,
      );
    }

    consider({
      author: position.author,
      actor: position.actor,
      at: position.at,
      approving: isApprovingVerdict(position.verdict),
      changesRequested: position.verdict === "CHANGES_REQUIRED",
      head: position.reviewedHead,
      // An edited comment never opens the gate: the verdict can be rewritten while the commit it
      // names stays fixed. It still closes one, below — refusing to open on doubtful evidence and
      // refusing to close on it are not symmetric, and only one of them is safe.
      gateClearing: independent && !contradicted && !position.edited,
    });
  }

  return { positions: [...latestByReviewer.values()], mutations };
}

/**
 * Verdict evidence on this PR that was altered after it was given.
 *
 * Surfaced rather than swallowed: the whole point of binding a verdict to a commit is that it
 * cannot move, so evidence that did move is a fact about the record the owner should see.
 */
export function deriveVerdictIntegrityWarnings(pr: GitHubPullRequestObservation): string[] {
  return activePositions(pr).mutations;
}

/**
 * The commits named by approvals that are still a reviewer's current position.
 *
 * GitHub stamps a review with the commit id it was submitted against, which makes this the one
 * final-head authority that cannot be self-referential: unlike a SHA written inside a commit, it
 * is created after the commit it describes exists.
 */
export function deriveApprovedHeadShas(pr: GitHubPullRequestObservation): string[] {
  const shas = new Set<string>();
  for (const position of activePositions(pr).positions) {
    if (!position.approving || !position.gateClearing) continue;
    if (position.head) shas.add(position.head.toLowerCase());
  }
  return [...shas].sort();
}

/**
 * Reviewers whose current position is `Changes required`.
 *
 * One reviewer's approval never cancels another's outstanding objection, so this is a list rather
 * than a flag: while it is non-empty, the gate is closed no matter who else approved.
 */
export function deriveChangesRequestedBy(pr: GitHubPullRequestObservation): string[] {
  // Reported by actor where one is declared: two objections relayed through one account are two
  // objections, and naming the login twice would hide that. An objection counts whether or not
  // it could have cleared the gate — closing it is always the safe direction.
  return activePositions(pr)
    .positions.filter((position) => position.changesRequested)
    .map((position) => position.actor ?? position.author)
    .sort();
}

export function deriveReviewState(pr: GitHubPullRequestObservation): ReviewState {
  const latestByReviewer = new Map<string, GitHubPullRequestObservation["reviews"][number]>();

  for (const review of pr.reviews) {
    if (review.state === "DISMISSED" || review.state === "PENDING") continue;
    const existing = latestByReviewer.get(review.author);
    if (!existing || review.submittedAt > existing.submittedAt) {
      latestByReviewer.set(review.author, review);
    }
  }

  const verdicts = [...latestByReviewer.values()];
  if (verdicts.some((r) => r.state === "CHANGES_REQUESTED")) return "CHANGES_REQUESTED";
  if (pr.requestedReviewers.length > 0) return "REVIEW_REQUESTED";
  if (verdicts.some((r) => r.state === "APPROVED")) return "APPROVED";
  if (verdicts.length > 0) return "COMMENTED";
  return "NONE";
}

/**
 * Failure wins over everything: one failed check means CI failed, whatever else is still
 * running. A re-run in progress does not soften a failure that is currently on the record —
 * that is the attention engine's job to interpret, not this function's to hide.
 */
export function deriveCiState(pr: GitHubPullRequestObservation): CiState {
  if (pr.checks.length === 0) return "NONE";

  const failing = pr.checks.some(
    (c) =>
      c.status === "completed" &&
      (c.conclusion === "failure" ||
        c.conclusion === "timed_out" ||
        c.conclusion === "action_required"),
  );
  if (failing) return "FAILED";

  if (pr.checks.some((c) => c.status === "in_progress")) return "RUNNING";
  if (pr.checks.some((c) => c.status === "queued")) return "PENDING";

  const anyMeaningfulSuccess = pr.checks.some(
    (c) => c.status === "completed" && (c.conclusion === "success" || c.conclusion === "neutral"),
  );
  return anyMeaningfulSuccess ? "PASSED" : "NONE";
}

export function deriveMergeability(pr: GitHubPullRequestObservation): MergeabilityState {
  switch (pr.mergeableState) {
    case "clean":
    case "has_hooks":
      return "CLEAN";
    case "dirty":
      return "CONFLICTED";
    case "blocked":
    case "behind":
    case "unstable":
    case "draft":
      return "BLOCKED";
    default:
      return "UNKNOWN";
  }
}

export function derivePullRequestState(
  projectId: string,
  pr: GitHubPullRequestObservation,
  source: SourceRef,
): PullRequestState {
  return {
    projectId,
    number: pr.number,
    title: pr.title,
    lifecycle: deriveLifecycle(pr),
    draft: pr.draft,
    headBranch: pr.headRef,
    headSha: pr.headSha,
    baseBranch: pr.baseRef,
    author: pr.author,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    mergeability: deriveMergeability(pr),
    reviewState: deriveReviewState(pr),
    ciState: deriveCiState(pr),
    requestedReviewers: [...pr.requestedReviewers],
    approvedHeadShas: deriveApprovedHeadShas(pr),
    changesRequestedBy: deriveChangesRequestedBy(pr),
    mutatedEvidence: deriveVerdictIntegrityWarnings(pr),
    // Populated by the Build OS layer, which is the only thing that knows about workstreams.
    workstreamIds: [],
    sourceUrl: pr.htmlUrl,
    source,
  };
}
