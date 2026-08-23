/**
 * Narrow observation shapes for GitHub.
 *
 * These are deliberately not the GitHub API response types. An observation is the small subset
 * of one poll cycle that the normalizer needs — which keeps the client swappable, keeps
 * fixtures readable, and stops GitHub's schema from leaking into the domain.
 */

export interface GitHubReviewObservation {
  id: number;
  author: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  submittedAt: string;
  htmlUrl: string;
}

export interface GitHubCheckObservation {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?:
    | "success"
    | "failure"
    | "cancelled"
    | "timed_out"
    | "neutral"
    | "skipped"
    | "action_required"
    | "stale";
  startedAt: string;
  completedAt?: string;
  htmlUrl: string;
}

export interface GitHubPullRequestObservation {
  number: number;
  title: string;
  /** GitHub's own word. `merged` is a separate flag because a merged PR is also closed. */
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt?: string;
  closedAt?: string;
  headRef: string;
  baseRef: string;
  author: string;
  authorIsBot: boolean;
  htmlUrl: string;
  /** GitHub's `mergeable_state`. Often `unknown` immediately after a push. */
  mergeableState?: string;
  requestedReviewers: string[];
  reviews: GitHubReviewObservation[];
  checks: GitHubCheckObservation[];
  body?: string;
}

export interface GitHubObservation {
  repositoryFullName: string;
  defaultBranch: string;
  /** When this poll happened. Drives snapshot recency, never event ordering. */
  observedAt: string;
  pullRequests: GitHubPullRequestObservation[];
}

/** A failed poll. State is retained and marked stale rather than erased. */
export interface GitHubSyncFailure {
  repositoryFullName: string;
  observedAt: string;
  reason: string;
  statusCode?: number;
}
