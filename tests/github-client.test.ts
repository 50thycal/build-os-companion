/**
 * The HTTP client's mapping layer, exercised with an injected fetch.
 *
 * A live run against api.github.com is not possible from the build environment (the egress proxy
 * blocks it), so the client is tested here rather than left to typecheck alone — this is the code
 * that turns GitHub's response shapes into observations, and it is easy to get quietly wrong.
 */

import { describe, expect, it } from "vitest";

import { GitHubApiError, HttpGitHubClient } from "../src/ingest/github/client.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function routedFetch(routes: Record<string, unknown>, missing = 404): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    const match = Object.keys(routes).find((path) => url.endsWith(path));
    if (!match) return new Response("not found", { status: missing, statusText: "Not Found" });
    return jsonResponse(routes[match]);
  }) as typeof fetch;
}

const REPO = "50thycal/cargo-ship";

const PULL = {
  number: 84,
  title: "Region-aware simulation",
  state: "open",
  draft: false,
  merged_at: null,
  closed_at: null,
  created_at: "2026-08-21T09:00:00Z",
  updated_at: "2026-08-23T11:40:00Z",
  head: { ref: "claude/regions", sha: "headsha" },
  base: { ref: "main" },
  user: { login: "50thycal", type: "User" },
  html_url: "https://github.com/50thycal/cargo-ship/pull/84",
  mergeable_state: "clean",
  requested_reviewers: [{ login: "reviewer-rae" }],
};

describe("HttpGitHubClient", () => {
  it("assembles an observation from the repo, list, detail, review and check endpoints", async () => {
    const client = new HttpGitHubClient({
      token: "t",
      fetchImpl: routedFetch({
        [`/repos/${REPO}`]: { default_branch: "main" },
        [`/repos/${REPO}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1`]: [PULL],
        [`/repos/${REPO}/pulls/84`]: PULL,
        [`/repos/${REPO}/pulls/84/reviews`]: [
          {
            id: 1,
            user: { login: "reviewer-rae" },
            state: "changes_requested",
            submitted_at: "2026-08-23T13:00:00Z",
            html_url: "https://github.com/o/r/pull/84#r1",
          },
          // An unsubmitted draft review must not become an observation.
          { id: 2, user: { login: "sam" }, state: "pending", html_url: "u" },
        ],
        [`/repos/${REPO}/commits/headsha/check-runs`]: {
          check_runs: [
            {
              id: 9001,
              name: "tests",
              status: "completed",
              conclusion: "failure",
              started_at: "2026-08-23T11:30:00Z",
              completed_at: "2026-08-23T11:38:00Z",
              html_url: "https://github.com/o/r/runs/9001",
            },
          ],
        },
      }),
    });

    const observation = await client.observe(REPO);
    const pr = observation.pullRequests[0]!;

    expect(observation.defaultBranch).toBe("main");
    expect(pr.number).toBe(84);
    expect(pr.merged).toBe(false);
    expect(pr.authorIsBot).toBe(false);
    expect(pr.requestedReviewers).toEqual(["reviewer-rae"]);
    expect(pr.reviews).toHaveLength(1);
    expect(pr.reviews[0]!.state).toBe("CHANGES_REQUESTED");
    expect(pr.checks[0]!.conclusion).toBe("failure");
  });

  it("reads issue comments, so a comment-borne verdict is observable", async () => {
    const client = new HttpGitHubClient({
      token: "t",
      fetchImpl: routedFetch({
        [`/repos/${REPO}`]: { default_branch: "main" },
        [`/repos/${REPO}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1`]: [PULL],
        [`/repos/${REPO}/pulls/84`]: PULL,
        [`/repos/${REPO}/pulls/84/reviews`]: [],
        [`/repos/${REPO}/issues/84/comments`]: [
          {
            id: 55,
            user: { login: "reviewer-rae" },
            body: "Build OS review verdict: Approved",
            created_at: "2026-08-23T14:00:00Z",
            html_url: "https://github.com/o/r/pull/84#issuecomment-55",
          },
        ],
        [`/repos/${REPO}/commits/headsha/check-runs`]: { check_runs: [] },
      }),
    });

    const pr = (await client.observe(REPO)).pullRequests[0]!;
    expect(pr.comments).toHaveLength(1);
    expect(pr.comments![0]!.author).toBe("reviewer-rae");
    expect(pr.comments![0]!.body).toContain("Build OS review verdict");
  });

  it("survives a comments endpoint that fails, and says it did not read them", async () => {
    // Alone among these calls it is additive: everything else decides whether the PR is seen at
    // all. `undefined` rather than `[]` keeps "not read" distinct from "read, and there were
    // none" — the difference between an unknown verdict and a known absent one.
    const client = new HttpGitHubClient({
      token: "t",
      fetchImpl: routedFetch({
        [`/repos/${REPO}`]: { default_branch: "main" },
        [`/repos/${REPO}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1`]: [PULL],
        [`/repos/${REPO}/pulls/84`]: PULL,
        [`/repos/${REPO}/pulls/84/reviews`]: [],
        [`/repos/${REPO}/commits/headsha/check-runs`]: { check_runs: [] },
      }),
    });

    const observation = await client.observe(REPO);
    expect(observation.pullRequests).toHaveLength(1);
    expect(observation.pullRequests[0]!.comments).toBeUndefined();
  });

  it("skips PRs untouched since the cursor", async () => {
    const client = new HttpGitHubClient({
      token: "t",
      fetchImpl: routedFetch({
        [`/repos/${REPO}`]: { default_branch: "main" },
        [`/repos/${REPO}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1`]: [PULL],
      }),
    });

    const observation = await client.observe(REPO, { updatedSince: "2026-08-24T00:00:00Z" });
    expect(observation.pullRequests).toHaveLength(0);
  });

  it("recognises a bot author", async () => {
    const bot = { ...PULL, user: { login: "dependabot[bot]", type: "Bot" } };
    const client = new HttpGitHubClient({
      token: "t",
      fetchImpl: routedFetch({
        [`/repos/${REPO}`]: { default_branch: "main" },
        [`/repos/${REPO}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1`]: [bot],
        [`/repos/${REPO}/pulls/84`]: bot,
        [`/repos/${REPO}/pulls/84/reviews`]: [],
        [`/repos/${REPO}/commits/headsha/check-runs`]: { check_runs: [] },
      }),
    });

    expect((await client.observe(REPO)).pullRequests[0]!.authorIsBot).toBe(true);
  });

  it("treats a missing Build OS directory as empty, not as a failure", async () => {
    const client = new HttpGitHubClient({ token: "t", fetchImpl: routedFetch({}) });
    expect(await client.listPaths(REPO, "docs/workstreams")).toEqual([]);
    expect(await client.readFile(REPO, "docs/PROJECT_MODEL.md")).toBeUndefined();
  });

  it("decodes file content and keeps the commit sha", async () => {
    const client = new HttpGitHubClient({
      token: "t",
      fetchImpl: routedFetch({
        [`/repos/${REPO}/contents/docs/workstreams/ACTIVE.md`]: {
          content: Buffer.from("# Active Work\n", "utf8").toString("base64"),
          encoding: "base64",
          sha: "filesha",
          html_url: "https://github.com/o/r/blob/main/docs/workstreams/ACTIVE.md",
        },
      }),
    });

    const file = await client.readFile(REPO, "docs/workstreams/ACTIVE.md");
    expect(file!.content).toBe("# Active Work\n");
    expect(file!.sha).toBe("filesha");
  });

  it("raises a typed error for a non-404 failure so sync can record it", async () => {
    const client = new HttpGitHubClient({
      token: "t",
      fetchImpl: (async () => new Response("nope", { status: 502, statusText: "Bad Gateway" })) as typeof fetch,
    });

    await expect(client.observe(REPO)).rejects.toBeInstanceOf(GitHubApiError);
  });
});

/**
 * Pagination.
 *
 * `per_page=30` on a single page was the whole of the old listing, in both places it matters:
 * the pull requests of one repository and the repositories of one account. A truncated answer is
 * indistinguishable downstream from a quiet one, which is how a portfolio of thirteen active
 * repositories rendered as two.
 */
describe("pagination", () => {
  function paged(pages: Record<string, unknown[]>, extra: Record<string, unknown> = {}): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      // Matched on the end of the URL, not with `includes`: `per_page=100&page=2` contains the
      // substring `page=1` (inside `per_page=100`), and a looser matcher answers every page with
      // page one's body — which loops forever.
      const match = Object.keys(pages).find((path) => url.endsWith(path));
      if (match) return jsonResponse(pages[match]);
      const other = Object.keys(extra).find((path) => url.endsWith(path));
      if (other) return jsonResponse(extra[other]);
      return new Response("not found", { status: 404, statusText: "Not Found" });
    }) as typeof fetch;
  }

  it("walks every page of repositories until the window is exhausted", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({
      full_name: `50thycal/r${i}`,
      default_branch: "main",
      pushed_at: "2026-08-27T00:00:00Z",
      private: false,
      fork: false,
      archived: false,
    }));
    const tail = [
      { full_name: "50thycal/last", default_branch: "main", pushed_at: "2026-08-26T00:00:00Z" },
      // Sorted by push descending, so this one ends the walk rather than being filtered alone.
      { full_name: "50thycal/old", default_branch: "main", pushed_at: "2026-01-01T00:00:00Z" },
    ];

    const client = new HttpGitHubClient({
      token: "t",
      fetchImpl: paged({ "page=1": full, "page=2": tail }),
    });

    const found = await client.listRepositories({ pushedSince: "2026-06-29T00:00:00Z" });
    expect(found).toHaveLength(101);
    expect(found.at(-1)!.fullName).toBe("50thycal/last");
    // The one outside the window is dropped rather than followed on a stale push.
    expect(found.map((r) => r.fullName)).not.toContain("50thycal/old");
  });

  it("stops walking once a page falls out of the window", async () => {
    let requested = 0;
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes("/user/repos")) {
        requested += 1;
        return jsonResponse([
          { full_name: "50thycal/a", default_branch: "main", pushed_at: "2026-01-01T00:00:00Z" },
        ]);
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    }) as typeof fetch;

    const client = new HttpGitHubClient({ token: "t", fetchImpl });
    await client.listRepositories({ pushedSince: "2026-06-29T00:00:00Z" });
    expect(requested).toBe(1);
  });

  it("counts owner commits, and falls back to pull requests when there are none", async () => {
    const client = new HttpGitHubClient({
      token: "t",
      fetchImpl: paged({}, {
        [`/repos/${REPO}/commits?author=50thycal&since=2026-06-29T00%3A00%3A00Z&per_page=100`]: [
          { sha: "a" },
          { sha: "b" },
        ],
      }),
    });

    expect(await client.ownerActivity(REPO, "50thycal", "2026-06-29T00:00:00Z")).toEqual({
      commits: 2,
      pullRequests: 0,
    });
  });

  it("attributes a repository by the owner's own pull requests, not everybody's", async () => {
    const client = new HttpGitHubClient({
      token: "t",
      fetchImpl: paged({}, {
        [`/repos/${REPO}/commits?author=50thycal&since=2026-06-29T00%3A00%3A00Z&per_page=100`]: [],
        [`/repos/${REPO}/pulls?state=all&sort=updated&direction=desc&per_page=100`]: [
          { ...PULL, updated_at: "2026-08-23T11:40:00Z" },
          { ...PULL, number: 85, user: { login: "someone-else" }, updated_at: "2026-08-23T11:40:00Z" },
          { ...PULL, number: 86, updated_at: "2026-01-01T00:00:00Z" },
        ],
      }),
    });

    expect(await client.ownerActivity(REPO, "50thycal", "2026-06-29T00:00:00Z")).toEqual({
      commits: 0,
      pullRequests: 1,
    });
  });

  it("answers no activity rather than failing when the token cannot read a repository", async () => {
    // Discovery must degrade to the push-time fallback for one repository, never take the whole
    // portfolio down because one listing was denied.
    const client = new HttpGitHubClient({
      token: "t",
      fetchImpl: (async () => new Response("no", { status: 403, statusText: "Forbidden" })) as typeof fetch,
    });

    expect(await client.ownerActivity(REPO, "50thycal", "2026-06-29T00:00:00Z")).toEqual({
      commits: 0,
      pullRequests: 0,
    });
  });
});
