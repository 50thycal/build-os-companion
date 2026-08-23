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
        [`/repos/${REPO}/pulls?state=all&sort=updated&direction=desc&per_page=30`]: [PULL],
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

  it("skips PRs untouched since the cursor", async () => {
    const client = new HttpGitHubClient({
      token: "t",
      fetchImpl: routedFetch({
        [`/repos/${REPO}`]: { default_branch: "main" },
        [`/repos/${REPO}/pulls?state=all&sort=updated&direction=desc&per_page=30`]: [PULL],
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
        [`/repos/${REPO}/pulls?state=all&sort=updated&direction=desc&per_page=30`]: [bot],
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
