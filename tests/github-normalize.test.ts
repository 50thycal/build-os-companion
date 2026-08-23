import { describe, expect, it } from "vitest";

import { InMemoryEventLedger } from "../src/ledger/ledger.ts";
import { normalizeGitHubObservation } from "../src/ingest/github/normalize.ts";
import {
  deriveCiState,
  deriveMergeability,
  deriveReviewState,
} from "../src/ingest/github/derive.ts";
import { projectPullRequests } from "../src/projection/project.ts";
import { observation } from "./helpers.ts";
import type { GitHubPullRequestObservation } from "../src/ingest/github/types.ts";

const PROJECT = "proj_cargo_ship";

function pr(overrides: Partial<GitHubPullRequestObservation> = {}): GitHubPullRequestObservation {
  return {
    number: 1,
    title: "Test",
    state: "open",
    draft: false,
    merged: false,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    headRef: "feature",
    baseRef: "main",
    author: "someone",
    authorIsBot: false,
    htmlUrl: "https://github.com/o/r/pull/1",
    requestedReviewers: [],
    reviews: [],
    checks: [],
    ...overrides,
  };
}

describe("github normalization", () => {
  it("emits intrinsic events on first sync and no invented transitions", () => {
    const drafts = normalizeGitHubObservation(observation(1), { projectId: PROJECT });
    const types = drafts.map((d) => d.eventType);

    expect(types.filter((t) => t === "PR_OPENED")).toHaveLength(3);
    // Nothing was witnessed changing, so nothing claims to have changed.
    expect(types).not.toContain("PR_UPDATED");
    expect(types).not.toContain("PR_READY_FOR_REVIEW");
  });

  it("is idempotent: the same observation twice appends nothing new", () => {
    const ledger = new InMemoryEventLedger();
    const first = ledger.append(
      normalizeGitHubObservation(observation(1), { projectId: PROJECT }),
    );
    const second = ledger.append(
      normalizeGitHubObservation(observation(1), { projectId: PROJECT }),
    );

    expect(first.appended.length).toBeGreaterThan(0);
    expect(second.appended).toHaveLength(0);
    expect(second.duplicates).toBe(first.appended.length);
    expect(ledger.size()).toBe(first.appended.length);
  });

  it("emits transitions only once a previous projection exists", () => {
    const ledger = new InMemoryEventLedger();
    ledger.append(normalizeGitHubObservation(observation(1), { projectId: PROJECT }));

    const previous = new Map(
      projectPullRequests(ledger.all()).map((p) => [p.number, p]),
    );
    const second = ledger.append(
      normalizeGitHubObservation(observation(2), { projectId: PROJECT, previous }),
    );

    const types = second.appended.map((e) => e.eventType);
    expect(types).toContain("PR_READY_FOR_REVIEW");
    expect(types).toContain("CI_FAILED");
    expect(types).toContain("PR_CHANGES_REQUESTED");
  });

  it("rebuilds current PR state from the ledger alone", () => {
    const ledger = new InMemoryEventLedger();
    ledger.append(normalizeGitHubObservation(observation(1), { projectId: PROJECT }));
    const previous = new Map(projectPullRequests(ledger.all()).map((p) => [p.number, p]));
    ledger.append(
      normalizeGitHubObservation(observation(2), { projectId: PROJECT, previous }),
    );

    const state = projectPullRequests(ledger.all());
    const pr84 = state.find((p) => p.number === 84)!;

    expect(pr84.draft).toBe(false);
    expect(pr84.ciState).toBe("FAILED");
    expect(pr84.lifecycle).toBe("OPEN");

    const pr91 = state.find((p) => p.number === 91)!;
    expect(pr91.reviewState).toBe("CHANGES_REQUESTED");

    const pr77 = state.find((p) => p.number === 77)!;
    expect(pr77.mergeability).toBe("CONFLICTED");
  });

  it("keeps every event traceable to a source url", () => {
    const drafts = normalizeGitHubObservation(observation(2), { projectId: PROJECT });
    expect(drafts.every((d) => typeof d.source.sourceUrl === "string")).toBe(true);
  });
});

describe("state derivation", () => {
  it("lets the newest verdict per reviewer decide", () => {
    const state = deriveReviewState(
      pr({
        reviews: [
          { id: 1, author: "rae", state: "CHANGES_REQUESTED", submittedAt: "2026-08-01T00:00:00Z", htmlUrl: "u" },
          { id: 2, author: "rae", state: "APPROVED", submittedAt: "2026-08-02T00:00:00Z", htmlUrl: "u" },
        ],
      }),
    );
    expect(state).toBe("APPROVED");
  });

  it("reinstates changes-requested when it is the newer verdict", () => {
    const state = deriveReviewState(
      pr({
        reviews: [
          { id: 1, author: "rae", state: "APPROVED", submittedAt: "2026-08-01T00:00:00Z", htmlUrl: "u" },
          { id: 2, author: "rae", state: "CHANGES_REQUESTED", submittedAt: "2026-08-02T00:00:00Z", htmlUrl: "u" },
        ],
      }),
    );
    expect(state).toBe("CHANGES_REQUESTED");
  });

  it("ignores unsubmitted and dismissed reviews", () => {
    expect(
      deriveReviewState(
        pr({
          reviews: [
            { id: 1, author: "rae", state: "PENDING", submittedAt: "2026-08-01T00:00:00Z", htmlUrl: "u" },
            { id: 2, author: "sam", state: "DISMISSED", submittedAt: "2026-08-01T00:00:00Z", htmlUrl: "u" },
          ],
        }),
      ),
    ).toBe("NONE");
  });

  it("does not let a re-run hide a failure that is on the record", () => {
    expect(
      deriveCiState(
        pr({
          checks: [
            { id: 1, name: "a", status: "completed", conclusion: "failure", startedAt: "t", completedAt: "t", htmlUrl: "u" },
            { id: 2, name: "a", status: "in_progress", startedAt: "t", htmlUrl: "u" },
          ],
        }),
      ),
    ).toBe("FAILED");
  });

  it("reports NONE rather than PASSED when every check was skipped", () => {
    expect(
      deriveCiState(
        pr({
          checks: [
            { id: 1, name: "a", status: "completed", conclusion: "skipped", startedAt: "t", completedAt: "t", htmlUrl: "u" },
          ],
        }),
      ),
    ).toBe("NONE");
  });

  it("maps mergeable_state conservatively", () => {
    expect(deriveMergeability(pr({ mergeableState: "dirty" }))).toBe("CONFLICTED");
    expect(deriveMergeability(pr({ mergeableState: "behind" }))).toBe("BLOCKED");
    expect(deriveMergeability(pr({}))).toBe("UNKNOWN");
  });
});
