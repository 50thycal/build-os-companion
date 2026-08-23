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
    baseBranch: pr.baseRef,
    author: pr.author,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    mergeability: deriveMergeability(pr),
    reviewState: deriveReviewState(pr),
    ciState: deriveCiState(pr),
    requestedReviewers: [...pr.requestedReviewers],
    // Populated by the Build OS layer, which is the only thing that knows about workstreams.
    workstreamIds: [],
    sourceUrl: pr.htmlUrl,
    source,
  };
}
