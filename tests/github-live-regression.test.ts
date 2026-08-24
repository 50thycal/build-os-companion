/**
 * Regressions found by running the sync path against real repositories.
 *
 * Every case here failed, or would have failed, against an actual GitHub response on
 * 2026-08-24 while validating `50thycal/party-games` and `50thycal/build-os`. The
 * injected-fetch tests passed throughout — these are the assumptions those tests encoded and
 * live data disproved. Fixtures live in `fixtures/github/live/`; the narrative is in
 * `docs/LIVE_SYNC_VALIDATION.md`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { HttpGitHubClient, isAgentBranch, isBotAuthor } from "../src/ingest/github/client.ts";
import { deriveCiState, deriveLifecycle, deriveMergeability } from "../src/ingest/github/derive.ts";
import { normalizeGitHubObservation } from "../src/ingest/github/normalize.ts";
import { describeQuietPullRequest } from "../src/domain/describe.ts";
import type { GitHubPullRequestObservation } from "../src/ingest/github/types.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "github", "live");
const load = (name: string) => JSON.parse(readFileSync(join(fixtures, name), "utf8"));

const listPayload = load("pulls-list-merged.json").payload as Record<string, unknown>[];
const detail142 = load("pull-detail-142-open.json").payload as Record<string, unknown>;
const detail141 = load("pull-detail-141-merged.json").payload as Record<string, unknown>;
const emptyChecks = load("checks-empty.json");

/** A fetch that answers from the recorded payloads, matching on path. */
function recordedFetch(overrides: Record<string, unknown> = {}): typeof fetch {
  return (async (url: string) => {
    const path = new URL(url).pathname + new URL(url).search;
    const body = (() => {
      for (const [fragment, value] of Object.entries(overrides)) {
        if (path.includes(fragment)) return value;
      }
      // Order matters: the sub-resource paths are prefixed by the PR path.
      if (path.endsWith("/party-games")) return { default_branch: "main" };
      if (path.includes("/pulls?")) return listPayload;
      if (path.includes("/reviews")) return [];
      if (path.includes("/check-runs")) return emptyChecks.checkRuns;
      if (path.includes("/status")) return emptyChecks.combinedStatus;
      if (path.includes("/pulls/142")) return detail142;
      if (path.includes("/pulls/141")) return detail141;

      // Any other PR: GitHub's detail endpoint returns the list entry plus `merged` and
      // `mergeable_state`. Synthesised the same way so the fixture stays faithful.
      const number = Number(path.split("/pulls/")[1]);
      const summary = listPayload.find((pr) => pr.number === number);
      if (summary) return { ...summary, merged: Boolean(summary.merged_at), mergeable_state: "unknown" };
      return {};
    })();
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

const observation = (over: Partial<GitHubPullRequestObservation> = {}): GitHubPullRequestObservation => ({
  number: 1,
  title: "t",
  state: "open",
  draft: false,
  merged: false,
  createdAt: "2026-08-24T00:00:00Z",
  updatedAt: "2026-08-24T00:00:00Z",
  headRef: "main",
  baseRef: "main",
  author: "50thycal",
  authorIsBot: false,
  htmlUrl: "https://github.com/50thycal/party-games/pull/1",
  requestedReviewers: [],
  reviews: [],
  checks: [],
  ...over,
});

// ---------------------------------------------------------------------------

describe("merged is absent from the pulls list payload", () => {
  it("every merged PR in the real list response carries merged_at but no merged field", () => {
    const merged = listPayload.filter((pr) => pr.merged_at);
    expect(merged.length).toBeGreaterThan(0);
    for (const pr of merged) {
      expect(pr).not.toHaveProperty("merged");
    }
  });

  it("derives merged from merged_at, so a merged PR is MERGED and not CLOSED", async () => {
    const client = new HttpGitHubClient({ token: "t", fetchImpl: recordedFetch() });
    const observed = await client.observe("50thycal/party-games", { mergeabilityRetries: 0 });

    const pr141 = observed.pullRequests.find((p) => p.number === 141)!;
    expect(pr141.merged).toBe(true);
    expect(deriveLifecycle(pr141)).toBe("MERGED");
  });

  it("a closed PR with no merged_at is still CLOSED", () => {
    expect(deriveLifecycle(observation({ state: "closed", merged: false }))).toBe("CLOSED");
  });
});

describe("mergeable_state is unknown on a freshly-read open PR", () => {
  it("the recorded open PR really did come back unknown", () => {
    expect(detail142.state).toBe("open");
    expect(detail142.mergeable_state).toBe("unknown");
    expect(deriveMergeability(observation({ mergeableState: "unknown" }))).toBe("UNKNOWN");
  });

  it("re-reads an open PR until mergeability resolves", async () => {
    let detailReads = 0;
    const resolving = recordedFetch();
    const fetchImpl = (async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/pulls/142")) {
        detailReads += 1;
        // GitHub answers `unknown` while it computes, then the real value.
        const body = detailReads === 1 ? detail142 : { ...detail142, mergeable_state: "dirty" };
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return resolving(url as never);
    }) as unknown as typeof fetch;

    const client = new HttpGitHubClient({ token: "t", fetchImpl });
    const observed = await client.observe("50thycal/party-games", {
      updatedSince: "2026-08-24T11:00:00Z",
      sleep: async () => {},
    });

    const pr142 = observed.pullRequests.find((p) => p.number === 142)!;
    expect(detailReads).toBeGreaterThan(1);
    expect(deriveMergeability(pr142)).toBe("CONFLICTED");
  });

  it("does not spend retries on a closed PR, whose mergeability never resolves", async () => {
    let detailReads = 0;
    const base = recordedFetch();
    const fetchImpl = (async (url: string) => {
      if (new URL(url).pathname.endsWith("/pulls/141")) detailReads += 1;
      return base(url as never);
    }) as unknown as typeof fetch;

    const client = new HttpGitHubClient({ token: "t", fetchImpl });
    await client.observe("50thycal/party-games", {
      updatedSince: "2026-08-24T05:00:00Z",
      sleep: async () => {},
    });

    expect(detailReads).toBe(1);
  });
});

describe("neither followed repository runs any CI", () => {
  it("an empty checks response is NONE, never PASSED", () => {
    expect(emptyChecks.checkRuns.total_count).toBe(0);
    expect(deriveCiState(observation({ checks: [] }))).toBe("NONE");
  });

  it("does not describe a PR with no checks as healthy", () => {
    const quiet = describeQuietPullRequest({
      number: 142,
      ciState: "NONE",
      reviewState: "NONE",
    } as never);

    expect(quiet).toContain("no checks reported");
    expect(quiet).not.toMatch(/healthy/i);
    // "none CI" was the old rendering: grammatically broken, and it read as a CI result.
    expect(quiet).not.toContain("none CI");
  });

  it("reads commit statuses too, so status-only CI is not invisible", async () => {
    const withStatus = recordedFetch({
      "/status": {
        state: "failure",
        total_count: 1,
        statuses: [
          {
            id: 900,
            state: "failure",
            context: "vercel",
            target_url: "https://vercel.com/x",
            created_at: "2026-08-24T11:10:00Z",
            updated_at: "2026-08-24T11:12:00Z",
          },
        ],
      },
    });

    const client = new HttpGitHubClient({ token: "t", fetchImpl: withStatus });
    const observed = await client.observe("50thycal/party-games", {
      updatedSince: "2026-08-24T11:00:00Z",
      mergeabilityRetries: 0,
    });

    const pr142 = observed.pullRequests.find((p) => p.number === 142)!;
    expect(pr142.checks.map((c) => c.kind)).toContain("COMMIT_STATUS");
    expect(deriveCiState(pr142)).toBe("FAILED");
  });
});

describe("agent work is authored by the owner's own account", () => {
  it("the real agent PRs are not bot accounts", () => {
    for (const pr of listPayload) {
      const user = pr.user as { login: string; type?: string };
      expect(isBotAuthor(user.login, user.type)).toBe(false);
    }
  });

  it("recognises the agent branch prefixes actually in use", () => {
    const branches = listPayload.map((pr) => (pr.head as { ref: string }).ref);
    expect(branches).toContain("codex/ws-002-noop-undo-fix");
    for (const ref of branches) expect(isAgentBranch(ref)).toBe(true);

    expect(isAgentBranch("claude/build-os-companion-extract-rn2xe4")).toBe(true);
    expect(isAgentBranch("main")).toBe(false);
    expect(isAgentBranch("feature/codex-rewrite")).toBe(false);
  });

  it("still detects a real bot by its login suffix when user.type is missing", () => {
    expect(isBotAuthor("dependabot[bot]")).toBe(true);
    expect(isBotAuthor("github-actions[bot]", undefined)).toBe(true);
    expect(isBotAuthor("50thycal", "User")).toBe(false);
  });

  it("credits an agent PR to an AGENT actor rather than to the owner", () => {
    const drafts = normalizeGitHubObservation(
      {
        repositoryFullName: "50thycal/party-games",
        defaultBranch: "main",
        observedAt: "2026-08-24T12:00:00Z",
        pullRequests: [observation({ number: 142, headRef: "codex/ws-002-noop-undo-fix", authorIsAgent: true })],
      },
      { projectId: "party-games" },
    );

    const opened = drafts.find((d) => d.eventType === "PR_OPENED")!;
    expect(opened.actor).toEqual({ type: "AGENT", name: "50thycal" });
  });
});
