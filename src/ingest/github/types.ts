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
  /**
   * The commit the review was submitted against, as GitHub recorded it. Optional because an
   * older observation or a hand-built fixture may not carry one — and because it is the field
   * the v0.5 final-head verification depends on, its absence must degrade rather than throw.
   */
  commitId?: string;
}

/**
 * GitHub reports CI two ways and a repository may use either or both.
 *
 * `CHECK_RUN` is the Checks API, written by GitHub Actions and modern apps. `COMMIT_STATUS` is
 * the older Statuses API, still what Vercel, Netlify, Travis and most deploy integrations post.
 * Reading only check runs makes a repository whose CI is entirely commit statuses look like a
 * repository with no CI — which is indistinguishable, downstream, from "everything passed".
 */
export type CheckKind = "CHECK_RUN" | "COMMIT_STATUS";

export interface GitHubCheckObservation {
  id: number;
  name: string;
  /** Absent means `CHECK_RUN`: observations recorded before statuses were read predate the field. */
  kind?: CheckKind;
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
  /** Full head commit SHA. The v0.5 review gate compares it against the reviewed head. */
  headSha: string;
  baseRef: string;
  author: string;
  authorIsBot: boolean;
  /**
   * The PR was produced by a coding agent working under the owner's own account.
   *
   * On the owner's real repositories every agent PR is authored by `50thycal` with
   * `user.type: "User"`, so bot detection alone reports all of it as hand-written. The branch
   * prefix (`claude/`, `codex/`) is the signal that survives, and it is what lets the attention
   * engine tell autonomous progress from the owner's own work.
   */
  authorIsAgent?: boolean;
  htmlUrl: string;
  /**
   * GitHub's `mergeable_state`. Computed asynchronously, so a read taken right after a push
   * returns `unknown` and only a later read resolves it. Every open PR observed during live
   * validation came back `unknown` on the first request.
   */
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
