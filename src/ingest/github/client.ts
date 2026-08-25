/**
 * GitHub polling client.
 *
 * Polling, not webhooks, is deliberate for the MVP: reconciliation and idempotency have to be
 * right before latency is worth optimizing, and a webhook is only a delivery mechanism — it is
 * never a guarantee of correct state. Reconciliation polling survives the webhook work either way.
 */

import type { BuildOsPaths } from "../../domain/state.ts";
import type {
  GitHubCheckObservation,
  GitHubCommentObservation,
  GitHubObservation,
  GitHubPullRequestObservation,
  GitHubReviewObservation,
} from "./types.ts";

export interface RepositoryFile {
  path: string;
  content: string;
  sha: string;
  htmlUrl: string;
}

/** The surface the sync orchestrator depends on. Fixtures implement this in tests. */
export interface GitHubPort {
  observe(repositoryFullName: string, options?: ObserveOptions): Promise<GitHubObservation>;
  listPaths(repositoryFullName: string, directory: string): Promise<string[]>;
  readFile(repositoryFullName: string, path: string): Promise<RepositoryFile | undefined>;
}

export interface ObserveOptions {
  /** Skip PRs untouched since this timestamp. The cursor that keeps polling cheap. */
  updatedSince?: string;
  /** Cap on PRs pulled in one cycle. */
  limit?: number;
  /**
   * How many extra reads to spend resolving `mergeable_state: "unknown"` on an *open* PR.
   * Zero disables the retry. Closed and merged PRs are never retried: GitHub stops computing
   * mergeability for them, so the answer would never arrive.
   */
  mergeabilityRetries?: number;
  /** Delay before each mergeability retry. Injectable so tests do not sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Base delay in milliseconds for the mergeability retry. */
  mergeabilityRetryDelayMs?: number;
}

export class GitHubApiError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "GitHubApiError";
    this.statusCode = statusCode;
  }
}

interface RawCommitStatus {
  id: number;
  state: "error" | "failure" | "pending" | "success";
  context: string;
  description?: string | null;
  target_url?: string | null;
  created_at: string;
  updated_at: string;
}

interface RawCombinedStatus {
  state: string;
  total_count: number;
  statuses: RawCommitStatus[];
}

interface RawPull {
  number: number;
  title: string;
  state: "open" | "closed";
  draft?: boolean;
  merged_at?: string | null;
  closed_at?: string | null;
  created_at: string;
  updated_at: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  user?: { login?: string; type?: string } | null;
  html_url: string;
  mergeable_state?: string;
  requested_reviewers?: { login: string }[] | null;
}

export class HttpGitHubClient implements GitHubPort {
  /** CI surfaces already warned about, so a missing permission logs once rather than per PR. */
  readonly #warnedSurfaces = new Set<string>();
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: { token: string; baseUrl?: string; fetchImpl?: typeof fetch }) {
    this.#token = options.token;
    this.#baseUrl = options.baseUrl ?? "https://api.github.com";
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async #get<T>(path: string): Promise<T> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.#token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "build-os-companion",
      },
    });

    if (!response.ok) {
      throw new GitHubApiError(
        `GET ${path} failed: ${response.status} ${response.statusText}`,
        response.status,
      );
    }
    return (await response.json()) as T;
  }

  /**
   * Resolve `mergeable_state` for an open PR.
   *
   * GitHub computes mergeability in the background and answers `unknown` until it finishes, so
   * a single read of a recently-pushed PR essentially never carries the answer. Leaving it
   * `unknown` is not a neutral outcome: `MERGE_CONFLICT` is one of the attention engine's rules,
   * and a permanently-unknown mergeability means that rule silently never fires. A conflicted PR
   * would then sit on the Feed looking healthy, which is exactly the kind of quiet wrong answer
   * the Needs Me screen exists to not produce.
   */
  async #resolveMergeability(
    repositoryFullName: string,
    detail: RawPull,
    options: ObserveOptions,
  ): Promise<RawPull> {
    const retries = options.mergeabilityRetries ?? 2;
    const delay = options.mergeabilityRetryDelayMs ?? 1000;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    let current = detail;
    for (let attempt = 0; attempt < retries; attempt += 1) {
      // Only an open PR is worth waiting for. GitHub stops computing mergeability once a PR is
      // closed or merged, so retrying those spends requests on an answer that will never come.
      if (current.state !== "open" || (current.mergeable_state ?? "unknown") !== "unknown") break;
      await sleep(delay * (attempt + 1));
      current = await this.#get<RawPull>(`/repos/${repositoryFullName}/pulls/${current.number}`);
    }
    return current;
  }

  /**
   * Read one of the two CI surfaces, tolerating the token not being allowed to.
   *
   * Both CI endpoints need a permission of their own — `Checks` for check runs, `Commit statuses`
   * for the older status API — and a fine-grained token can perfectly reasonably be issued
   * without either. When that happens GitHub answers 403, and the naive thing to do is let it
   * propagate: `observe()` throws, the sync is recorded as failed, and the owner loses pull
   * requests, workstreams and decisions for that repository because one *optional* signal was
   * denied. Losing everything to protect nothing.
   *
   * So CI is best-effort. 403 (not granted) and 404 (nothing there) both mean "no CI visible",
   * which is what `CiState.NONE` already says and what the interface renders as "no checks
   * reported" — a phrase that is true either way and never claims a green build. Anything else,
   * including 401 on a bad token and 5xx, still propagates: those are real failures and the
   * owner should see the repository marked stale rather than quietly missing CI.
   */
  async #readCiSurface<T>(path: string, surface: string, empty: T): Promise<T> {
    try {
      return await this.#get<T>(path);
    } catch (error) {
      if (error instanceof GitHubApiError && (error.statusCode === 403 || error.statusCode === 404)) {
        // Once per observation, not once per pull request: a token missing a permission would
        // otherwise print a line for every PR in the repository, every cycle.
        if (!this.#warnedSurfaces.has(surface)) {
          this.#warnedSurfaces.add(surface);
          console.warn(
            `[companion] cannot read ${surface} (HTTP ${error.statusCode}). CI will show as ` +
              `"no checks reported" for this repository. Grant the token read access to ${surface} ` +
              `if you want CI state.`,
          );
        }
        return empty;
      }
      throw error;
    }
  }

  /**
   * Commit statuses for a head SHA, mapped onto the same shape as check runs.
   *
   * A missing or empty combined status is a normal answer, not a failure.
   */
  async #commitStatuses(repositoryFullName: string, sha: string): Promise<RawCommitStatus[]> {
    const combined = await this.#readCiSurface<RawCombinedStatus>(
      `/repos/${repositoryFullName}/commits/${sha}/status`,
      "Commit statuses",
      { state: "pending", total_count: 0, statuses: [] },
    );
    return combined.statuses ?? [];
  }

  async observe(repositoryFullName: string, options: ObserveOptions = {}): Promise<GitHubObservation> {
    const observedAt = new Date().toISOString();
    const repo = await this.#get<{ default_branch: string }>(`/repos/${repositoryFullName}`);

    const list = await this.#get<RawPull[]>(
      `/repos/${repositoryFullName}/pulls?state=all&sort=updated&direction=desc&per_page=${
        options.limit ?? 30
      }`,
    );

    const relevant = list.filter(
      (pr) => !options.updatedSince || pr.updated_at > options.updatedSince,
    );

    const pullRequests: GitHubPullRequestObservation[] = [];
    for (const summary of relevant) {
      // The list endpoint omits both `merged` and `mergeable_state`; the detail endpoint is the
      // only source for either.
      const initial = await this.#get<RawPull>(
        `/repos/${repositoryFullName}/pulls/${summary.number}`,
      );
      const detail = await this.#resolveMergeability(repositoryFullName, initial, options);

      const reviews = await this.#get<
        { id: number; user?: { login?: string }; state: string; submitted_at?: string; html_url: string }[]
      >(`/repos/${repositoryFullName}/pulls/${summary.number}/reviews`);

      /**
       * Issue comments, for verdicts GitHub would not let the reviewer file as a review.
       * One extra request per PR per cycle, which is the price of the gate working at all in a
       * single-account repository. See `comment-verdict.ts`.
       *
       * Alone among these calls it is additive rather than load-bearing, so its failure must not
       * sink the poll: everything else here decides whether the PR is seen at all. Left
       * `undefined` rather than `[]` on failure, because those mean different things — "not
       * read" must not read downstream as "read, and there were none".
       */
      let comments: RawComment[] | undefined;
      try {
        comments = await this.#get<RawComment[]>(
          `/repos/${repositoryFullName}/issues/${summary.number}/comments`,
        );
      } catch {
        comments = undefined;
      }

      // Both halves of GitHub's CI surface. A repository may use either, both, or neither.
      const checks = await this.#readCiSurface<{
        check_runs: {
          id: number;
          name: string;
          status: string;
          conclusion?: string | null;
          started_at?: string;
          completed_at?: string | null;
          html_url?: string;
        }[];
      }>(`/repos/${repositoryFullName}/commits/${detail.head.sha}/check-runs`, "Checks", {
        check_runs: [],
      });
      const statuses = await this.#commitStatuses(repositoryFullName, detail.head.sha);

      pullRequests.push(
        toObservation(detail, reviews, comments, checks.check_runs, statuses, repositoryFullName),
      );
    }

    return {
      repositoryFullName,
      defaultBranch: repo.default_branch,
      observedAt,
      pullRequests,
    };
  }

  async listPaths(repositoryFullName: string, directory: string): Promise<string[]> {
    try {
      const entries = await this.#get<{ path: string; type: string }[]>(
        `/repos/${repositoryFullName}/contents/${directory}`,
      );
      return entries.filter((e) => e.type === "file").map((e) => e.path);
    } catch (error) {
      // A missing directory is a normal answer, not a failure: plenty of repositories have no
      // Build OS layout at all.
      if (error instanceof GitHubApiError && error.statusCode === 404) return [];
      throw error;
    }
  }

  async readFile(repositoryFullName: string, path: string): Promise<RepositoryFile | undefined> {
    try {
      const file = await this.#get<{
        content?: string;
        encoding?: string;
        sha: string;
        html_url: string;
      }>(`/repos/${repositoryFullName}/contents/${path}`);

      if (!file.content || file.encoding !== "base64") return undefined;
      return {
        path,
        content: Buffer.from(file.content, "base64").toString("utf8"),
        sha: file.sha,
        htmlUrl: file.html_url,
      };
    } catch (error) {
      if (error instanceof GitHubApiError && error.statusCode === 404) return undefined;
      throw error;
    }
  }
}

/**
 * A commit status expressed as a check observation, so downstream code has one CI shape.
 *
 * `error` and `failure` are both failures; GitHub distinguishes them by cause, not by outcome,
 * and nothing the owner decides turns on which one it was.
 */
function statusToCheck(status: RawCommitStatus, fallbackUrl: string): GitHubCheckObservation {
  const completed = status.state === "success" || status.state === "failure" || status.state === "error";
  return {
    id: status.id,
    name: status.context,
    kind: "COMMIT_STATUS",
    status: completed ? "completed" : "in_progress",
    conclusion: completed ? (status.state === "success" ? "success" : "failure") : undefined,
    startedAt: status.created_at,
    completedAt: completed ? status.updated_at : undefined,
    htmlUrl: status.target_url ?? fallbackUrl,
  };
}

const AGENT_BRANCH_PREFIX = /^(claude|codex|devin|copilot|cursor|aider|jules)\//i;

/**
 * Whether a pull request was written by a coding agent rather than typed by the owner.
 *
 * Deliberately based on the branch prefix rather than the author. On the owner's repositories
 * an agent pushes under the owner's own GitHub account, so `user.type` is `User` for hand-written
 * and agent-written work alike, and every agent PR would otherwise be indistinguishable from
 * something the owner sat down and wrote.
 */
export function isAgentBranch(headRef: string): boolean {
  return AGENT_BRANCH_PREFIX.test(headRef);
}

/**
 * Whether the author is a bot account.
 *
 * `user.type` is the documented signal but is absent from some payload shapes, so the `[bot]`
 * login suffix — which GitHub reserves for app accounts — is checked as well.
 */
export function isBotAuthor(login: string, type?: string): boolean {
  return type === "Bot" || /\[bot\]$/i.test(login);
}

interface RawComment {
  id: number;
  user?: { login?: string };
  body?: string;
  created_at: string;
  html_url: string;
}

function toObservation(
  pr: RawPull,
  reviews: {
    id: number;
    user?: { login?: string };
    state: string;
    submitted_at?: string;
    html_url: string;
    commit_id?: string;
  }[],
  comments: RawComment[] | undefined,
  checkRuns: {
    id: number;
    name: string;
    status: string;
    conclusion?: string | null;
    started_at?: string;
    completed_at?: string | null;
    html_url?: string;
  }[],
  commitStatuses: RawCommitStatus[],
  repositoryFullName: string,
): GitHubPullRequestObservation {
  const mappedReviews: GitHubReviewObservation[] = reviews
    .filter((r) => r.submitted_at)
    .map((r) => ({
      id: r.id,
      author: r.user?.login ?? "unknown",
      state: r.state.toUpperCase() as GitHubReviewObservation["state"],
      submittedAt: r.submitted_at!,
      htmlUrl: r.html_url,
      commitId: r.commit_id,
    }));

  // Array-checked, not just presence-checked: an endpoint that answers with an error object
  // carrying a 200, or a payload shape that changes, must degrade to "not read" like any other
  // failure rather than throw inside the mapper and take the whole poll down with it.
  const mappedComments: GitHubCommentObservation[] | undefined = Array.isArray(comments)
    ? comments.map((c) => ({
        id: c.id,
        author: c.user?.login ?? "unknown",
        body: c.body ?? "",
        createdAt: c.created_at,
        htmlUrl: c.html_url,
      }))
    : undefined;

  const htmlUrl = pr.html_url ?? `https://github.com/${repositoryFullName}/pull/${pr.number}`;

  const mappedChecks: GitHubCheckObservation[] = [
    ...checkRuns.map((c) => ({
      id: c.id,
      name: c.name,
      kind: "CHECK_RUN" as const,
      status: c.status as GitHubCheckObservation["status"],
      conclusion: (c.conclusion ?? undefined) as GitHubCheckObservation["conclusion"],
      startedAt: c.started_at ?? pr.updated_at,
      completedAt: c.completed_at ?? undefined,
      htmlUrl: c.html_url ?? htmlUrl,
    })),
    ...commitStatuses.map((s) => statusToCheck(s, htmlUrl)),
  ];

  const author = pr.user?.login ?? "unknown";

  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    draft: pr.draft ?? false,
    // Never `pr.merged`: the list endpoint omits that field entirely, so trusting it reports
    // every merged pull request as merely closed. `merged_at` is present in both payloads.
    merged: Boolean(pr.merged_at),
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    mergedAt: pr.merged_at ?? undefined,
    closedAt: pr.closed_at ?? undefined,
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    baseRef: pr.base.ref,
    author,
    authorIsBot: isBotAuthor(author, pr.user?.type),
    authorIsAgent: isAgentBranch(pr.head.ref),
    htmlUrl,
    mergeableState: pr.mergeable_state,
    requestedReviewers: (pr.requested_reviewers ?? []).map((r) => r.login),
    reviews: mappedReviews,
    comments: mappedComments,
    checks: mappedChecks,
  };
}
