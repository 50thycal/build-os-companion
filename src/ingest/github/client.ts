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
}

export class GitHubApiError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "GitHubApiError";
    this.statusCode = statusCode;
  }
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
      // The list endpoint omits mergeable_state; the detail endpoint is the only source.
      const detail = await this.#get<RawPull>(
        `/repos/${repositoryFullName}/pulls/${summary.number}`,
      );
      const reviews = await this.#get<
        { id: number; user?: { login?: string }; state: string; submitted_at?: string; html_url: string }[]
      >(`/repos/${repositoryFullName}/pulls/${summary.number}/reviews`);
      const checks = await this.#get<{
        check_runs: {
          id: number;
          name: string;
          status: string;
          conclusion?: string | null;
          started_at?: string;
          completed_at?: string | null;
          html_url?: string;
        }[];
      }>(`/repos/${repositoryFullName}/commits/${detail.head.sha}/check-runs`);

      pullRequests.push(
        toObservation(detail, reviews, checks.check_runs, repositoryFullName),
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

function toObservation(
  pr: RawPull,
  reviews: { id: number; user?: { login?: string }; state: string; submitted_at?: string; html_url: string }[],
  checkRuns: {
    id: number;
    name: string;
    status: string;
    conclusion?: string | null;
    started_at?: string;
    completed_at?: string | null;
    html_url?: string;
  }[],
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
    }));

  const mappedChecks: GitHubCheckObservation[] = checkRuns.map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status as GitHubCheckObservation["status"],
    conclusion: (c.conclusion ?? undefined) as GitHubCheckObservation["conclusion"],
    startedAt: c.started_at ?? pr.updated_at,
    completedAt: c.completed_at ?? undefined,
    htmlUrl: c.html_url ?? pr.html_url,
  }));

  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    draft: pr.draft ?? false,
    merged: Boolean(pr.merged_at),
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    mergedAt: pr.merged_at ?? undefined,
    closedAt: pr.closed_at ?? undefined,
    headRef: pr.head.ref,
    baseRef: pr.base.ref,
    author: pr.user?.login ?? "unknown",
    authorIsBot: pr.user?.type === "Bot",
    htmlUrl: pr.html_url ?? `https://github.com/${repositoryFullName}/pull/${pr.number}`,
    mergeableState: pr.mergeable_state,
    requestedReviewers: (pr.requested_reviewers ?? []).map((r) => r.login),
    reviews: mappedReviews,
    checks: mappedChecks,
  };
}
