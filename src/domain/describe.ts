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

import type { CiState, PullRequestState, ReviewState, WorkstreamPhase } from "./state.ts";

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
 * The quiet-state sentence for a pull request nothing is wrong with.
 *
 * Says "nothing is asking for you", never "this is fine": with no CI configured there is no
 * evidence the code works, and the owner is entitled to know the difference between a green
 * build and an empty one.
 */
export function describeQuietPullRequest(pr: PullRequestState): string {
  return `PR #${pr.number}: ${describeCi(pr.ciState)}, ${describeReview(pr.reviewState)}. Nothing is waiting on you.`;
}
