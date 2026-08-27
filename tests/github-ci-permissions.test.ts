/**
 * A denied CI permission must cost you CI, not the repository.
 *
 * Both CI endpoints need a permission of their own — `Checks` for check runs, `Commit statuses`
 * for the older status API — and a fine-grained token can reasonably be issued without either.
 * Before this, the check-runs call had no error handling at all: a 403 propagated out of
 * `observe()`, the whole sync was recorded as failed, and the owner lost pull requests,
 * workstreams and decisions for that repository because one optional signal was denied.
 */

import { describe, expect, it, vi } from "vitest";

import { HttpGitHubClient } from "../src/ingest/github/client.ts";
import { deriveCiState } from "../src/ingest/github/derive.ts";

const PR = {
  number: 142,
  title: "fix(subway): preserve undo across no-op schedule selections",
  state: "open" as const,
  draft: false,
  created_at: "2026-08-24T11:05:02Z",
  updated_at: "2026-08-24T11:51:58Z",
  head: { ref: "codex/ws-002-noop-undo-fix", sha: "4efb4715" },
  base: { ref: "main" },
  user: { login: "50thycal", type: "User" },
  html_url: "https://github.com/50thycal/party-games/pull/142",
  mergeable_state: "clean",
  requested_reviewers: [],
};

/** Answers normally except on the CI surfaces named in `deny`, which get the given status. */
function fetchWith(deny: Record<string, number>): typeof fetch {
  return (async (url: string) => {
    const parsed = new URL(url);
    // Match on path *and* query: the pull-request list is distinguished from a single PR only
    // by its query string, which `pathname` drops.
    const path = parsed.pathname + parsed.search;
    for (const [fragment, status] of Object.entries(deny)) {
      if (path.includes(fragment)) {
        return new Response(JSON.stringify({ message: "Resource not accessible by personal access token" }), { status });
      }
    }
    const body = parsed.pathname.endsWith("/party-games")
      ? { default_branch: "main" }
      : parsed.pathname.endsWith("/pulls")
        ? [PR]
        : path.includes("/reviews") || path.includes("/comments")
          ? []
          : path.includes("/check-runs")
            ? { check_runs: [{ id: 1, name: "build", status: "completed", conclusion: "failure", started_at: "2026-08-24T11:00:00Z", completed_at: "2026-08-24T11:10:00Z" }] }
            : path.includes("/status")
              ? { state: "success", total_count: 1, statuses: [{ id: 2, state: "success", context: "vercel", created_at: "2026-08-24T11:00:00Z", updated_at: "2026-08-24T11:05:00Z" }] }
              : PR;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

const observe = (deny: Record<string, number> = {}) =>
  new HttpGitHubClient({ token: "t", fetchImpl: fetchWith(deny) }).observe("50thycal/party-games", {
    mergeabilityRetries: 0,
  });

describe("a token without the Checks permission", () => {
  it("still syncs the repository", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const observed = await observe({ "/check-runs": 403 });

      // The pull request survived; only CI is missing.
      expect(observed.pullRequests).toHaveLength(1);
      expect(observed.pullRequests[0]!.number).toBe(142);
      expect(observed.pullRequests[0]!.checks.map((c) => c.kind)).toEqual(["COMMIT_STATUS"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("says so once, naming the permission", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await observe({ "/check-runs": 403 });
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]![0]).toContain("Checks");
      expect(warn.mock.calls[0]![0]).toContain("403");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("a token without the Commit statuses permission", () => {
  it("still syncs, and keeps the check runs it can read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const observed = await observe({ "/commits/4efb4715/status": 403 });
      expect(observed.pullRequests).toHaveLength(1);
      expect(observed.pullRequests[0]!.checks.map((c) => c.kind)).toEqual(["CHECK_RUN"]);
      expect(deriveCiState(observed.pullRequests[0]!)).toBe("FAILED");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("a token without either CI permission", () => {
  it("still syncs, and reports no checks rather than a green build", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const observed = await observe({ "/check-runs": 403, "/commits/4efb4715/status": 403 });

      expect(observed.pullRequests).toHaveLength(1);
      expect(observed.pullRequests[0]!.checks).toHaveLength(0);
      // NONE renders as "no checks reported" — true whether CI is absent or unreadable, and it
      // never claims a build passed.
      expect(deriveCiState(observed.pullRequests[0]!)).toBe("NONE");
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("tolerates 404 the same way as 403", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const observed = await observe({ "/check-runs": 404, "/commits/4efb4715/status": 404 });
      expect(observed.pullRequests).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("a token without the Issues permission", () => {
  // Pull request comments are read through the same best-effort path, and for the same reason:
  // they carry the verdicts the merge gate depends on, but losing every workstream in the
  // repository because that one read was denied is the same bad trade.
  it("still syncs, and says it did not read the comments", async () => {
    const observation = await observe({ "/comments": 403 });
    expect(observation.pullRequests).toHaveLength(1);
    // `undefined`, not `[]` — "not read" and "read, and there were none" are different claims,
    // and only one of them means a comment verdict could be sitting there unseen.
    expect(observation.pullRequests[0]!.comments).toBeUndefined();
  });

  it("tolerates 404 the same way as 403", async () => {
    const observation = await observe({ "/comments": 404 });
    expect(observation.pullRequests[0]!.comments).toBeUndefined();
  });

  it("propagates a bad token rather than pretending there were no verdicts", async () => {
    await expect(observe({ "/comments": 401 })).rejects.toThrow(/401/);
  });
});

describe("real failures are still failures", () => {
  it("propagates a bad token rather than pretending CI is empty", async () => {
    // 401 means the credential itself is wrong. Degrading here would show a healthy-looking
    // repository built on nothing.
    await expect(observe({ "/check-runs": 401 })).rejects.toThrow(/401/);
  });

  it("propagates a server error, so the project is marked stale and retried", async () => {
    await expect(observe({ "/check-runs": 500 })).rejects.toThrow(/500/);
  });

  it("propagates a failure on a non-CI endpoint", async () => {
    // Losing the pull request list is not survivable; it is the sync.
    await expect(observe({ "/pulls?": 403 })).rejects.toThrow(/403/);
  });
});
