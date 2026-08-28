/**
 * Shared phrasing for state the owner reads.
 *
 * These strings appear on feed cards, on the Needs Me screen, and in the written briefing, and
 * they have to say the same thing in all three — a PR that is "CI green" in one place and
 * "passed" in another reads like two different facts about two different PRs.
 *
 * The rule they enforce: never let an absence of evidence render as evidence. Neither followed
 * repository runs any CI at all, so every real pull request projects `CiState.NONE`. Rendering
 * that as "none CI" inside the sentence "PR #142 is healthy" tells the owner a green build
 * exists. What is true is that nothing has reported.
 */

import type {
  CiState,
  PullRequestLifecycle,
  PullRequestState,
  ReviewState,
  WorkstreamPhase,
} from "./state.ts";

/**
 * A short relative time — `17 min ago`, `6 h ago`, `3 d ago`.
 *
 * Lives here rather than in the web layer because the same phrase has to appear in a card, in a
 * written briefing, and eventually in narration, and three implementations of "how long ago" is
 * three chances for them to disagree about the same moment.
 */
export function relativeTime(from: string, now: Date): string {
  const ms = now.getTime() - new Date(from).getTime();
  if (Number.isNaN(ms)) return "at an unknown time";
  if (ms < 0) return "just now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} d ago`;
}

export function describeCi(state: CiState): string {
  switch (state) {
    case "NONE":
      return "no checks reported";
    case "PENDING":
      return "checks queued";
    case "RUNNING":
      return "checks running";
    case "PASSED":
      return "checks green";
    case "FAILED":
      return "checks failing";
  }
}

export function describeReview(state: ReviewState): string {
  switch (state) {
    case "NONE":
      return "no review yet";
    case "REVIEW_REQUESTED":
      return "review requested";
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes requested";
    case "COMMENTED":
      return "reviewed with comments";
  }
}

export function describePhase(phase: WorkstreamPhase | undefined): string {
  return phase ? phase.replace(/_/g, " ").toLowerCase() : "phase unknown";
}

/**
 * Where a pull request *stands*, which is a different question at each point in its life.
 *
 * The original version of this rendered CI and review for every pull request regardless of
 * lifecycle, so a merged PR that nobody had reviewed reported `checks green, no review yet` as
 * its current state — an accurate pair of historical facts assembled into a false sentence,
 * because "no review yet" says review is still to come. After a merge it never is.
 *
 * So the lifecycle conclusion leads, and the pre-merge facts follow it as history, explicitly
 * marked as history. Nothing is discarded: the owner can still see that a merged PR carried no
 * review, which is exactly the fact the merge gate cares about. It simply stops being phrased as
 * an outstanding obligation.
 */
export function describePullRequestStanding(pr: PullRequestState, now: Date): string {
  if (pr.lifecycle === "MERGED") {
    const when = pr.mergedAt ? ` ${relativeTime(pr.mergedAt, now)}` : "";
    return `Merged${when} into ${pr.baseBranch}. ${describePreMergeHistory(pr)}`;
  }

  if (pr.lifecycle === "CLOSED") {
    const when = pr.closedAt ? ` ${relativeTime(pr.closedAt, now)}` : "";
    return `Closed${when} without merging; nothing from it reached ${pr.baseBranch}. ${describePreMergeHistory(pr)}`;
  }

  const merge =
    pr.mergeability === "CONFLICTED"
      ? ", conflicts with the base branch"
      : pr.mergeability === "BLOCKED"
        ? ", merge blocked"
        : "";
  const draft = pr.lifecycle === "DRAFT" ? "Draft: " : "";
  return `${draft}${describeCi(pr.ciState)}, ${describeReview(pr.reviewState)}${merge}.`;
}

/**
 * What CI and review had to say before the pull request settled, in the past tense.
 *
 * `NONE` on both is the case worth being careful about. "No checks reported, no review yet" was
 * the old output and it reads as a pending obligation; what is actually true is that this
 * changed the base branch on nobody's evidence, and the owner should be able to see that.
 */
function describePreMergeHistory(pr: PullRequestState): string {
  const noChecks = pr.ciState === "NONE";
  const noReview = pr.reviewState === "NONE";

  if (noChecks && noReview) return "No checks ran on it and no review was recorded.";
  if (noChecks) return `No checks ran on it; ${describeReviewPast(pr.reviewState)}.`;
  if (noReview) return `Beforehand: ${describeCi(pr.ciState)}; no review was recorded.`;
  return `Beforehand: ${describeCi(pr.ciState)}, ${describeReviewPast(pr.reviewState)}.`;
}

function describeReviewPast(state: ReviewState): string {
  switch (state) {
    case "NONE":
      return "no review was recorded";
    case "REVIEW_REQUESTED":
      return "a review had been requested";
    case "APPROVED":
      return "it was approved";
    case "CHANGES_REQUESTED":
      return "changes had been requested";
    case "COMMENTED":
      return "it was reviewed with comments";
  }
}

/** True for a pull request whose story is over. Nothing about it is an outstanding obligation. */
export function isSettled(lifecycle: PullRequestLifecycle): boolean {
  return lifecycle === "MERGED" || lifecycle === "CLOSED";
}

/**
 * The quiet-state sentence for a pull request nothing is wrong with.
 *
 * Says "nothing is asking for you", never "this is fine": with no CI configured there is no
 * evidence the code works, and the owner is entitled to know the difference between a green
 * build and an empty one.
 */
export function describeQuietPullRequest(pr: PullRequestState): string {
  return `PR #${pr.number}: ${describeCi(pr.ciState)}, ${describeReview(pr.reviewState)}. Nothing is waiting on you.`;
}
