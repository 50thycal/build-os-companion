/**
 * End-to-end: sources -> ledger -> state -> attention -> feed, with no network.
 */

import { describe, expect, it } from "vitest";

import { syncProject } from "../src/sync/sync-project.ts";
import { InMemoryEventLedger } from "../src/ledger/ledger.ts";
import { GitHubApiError, type GitHubPort } from "../src/ingest/github/client.ts";
import { FixtureGitHub, observation, testProject } from "./helpers.ts";
import { validateCheckpoint } from "../src/ingest/checkpoint/validate.ts";
import { toSessionState } from "../src/ingest/checkpoint/normalize.ts";
import { fixtureJson } from "./helpers.ts";

const NOW = new Date("2026-08-23T18:00:00Z");
const OWNER = "50thycal";

function sessionFrom(fixture: string, checkpointSource: "API" | "GITHUB" = "API") {
  const parsed = validateCheckpoint(fixtureJson("checkpoints", fixture));
  if (!parsed.ok) throw new Error(`fixture ${fixture} must be valid`);
  return toSessionState(parsed.checkpoint, {
    projectId: "proj_cargo_ship",
    checkpointSource,
    receivedAt: NOW.toISOString(),
  });
}

describe("sync cycle", () => {
  it("produces a ledger, state, attention and a feed from one cycle", async () => {
    const ledger = new InMemoryEventLedger();
    const result = await syncProject({
      project: testProject(),
      github: new FixtureGitHub([observation(1)]),
      ledger,
      ownerLogin: OWNER,
      now: NOW,
    });

    expect(result.appended.length).toBeGreaterThan(0);
    expect(result.state.pullRequests).toHaveLength(3);
    expect(result.state.workstreams.length).toBeGreaterThan(0);
    expect(result.cards.length).toBeGreaterThan(0);
    expect(result.attention.length).toBeGreaterThan(0);
  });

  it("appends nothing new when the same cycle is polled twice", async () => {
    const ledger = new InMemoryEventLedger();
    const github = new FixtureGitHub([observation(1), observation(1)]);
    const project = testProject();

    const first = await syncProject({ project, github, ledger, ownerLogin: OWNER, now: NOW });
    const second = await syncProject({
      project,
      github,
      ledger,
      ownerLogin: OWNER,
      now: NOW,
      previousPullRequests: new Map(first.state.pullRequests.map((p) => [p.number, p])),
      previousWorkstreams: new Map(first.state.workstreams.map((w) => [w.workstreamId, w])),
    });

    expect(second.appended).toHaveLength(0);
    expect(second.duplicates).toBeGreaterThan(0);
    expect(ledger.size()).toBe(first.appended.length);
  });

  it("keeps previous state and records a failure when GitHub is unreachable", async () => {
    const ledger = new InMemoryEventLedger();
    const project = testProject();

    const good = await syncProject({
      project,
      github: new FixtureGitHub([observation(1)]),
      ledger,
      ownerLogin: OWNER,
      now: NOW,
    });

    const failed = await syncProject({
      project,
      github: new FixtureGitHub([], new GitHubApiError("502 Bad Gateway", 502)),
      ledger,
      ownerLogin: OWNER,
      now: new Date("2026-08-23T19:00:00Z"),
    });

    expect(failed.syncFailed).toContain("502");
    // State survives the outage rather than being erased.
    expect(failed.state.pullRequests).toHaveLength(good.state.pullRequests.length);
    expect(failed.appended.map((e) => e.eventType)).toContain("SYNC_FAILED");
    expect(failed.attention.some((a) => a.reasonCode === "SYNC_FAILING")).toBe(true);
  });

  /**
   * A repository whose pull-request data GitHub answers fine but whose Build OS artifacts a
   * cycle cannot read or parse.
   *
   * This reproduces a real production defect: `loadBuildOsState` was not wrapped the way
   * `observe()` is, so a non-404 error reading `ACTIVE.md`, a workstream file, or `CLAUDE.md`
   * propagated out of the whole cycle. The pull-request events from `observe()` had already been
   * appended to the ledger a moment earlier, but `buildProjectState` never ran to project them
   * into `state.pullRequests` — so the Feed showed a card with a real headline ("PR #20 merged: …")
   * and `Where it stands: No current state recorded.`, while the project carried a `last sync
   * failed` badge even though GitHub itself was never unreachable.
   */
  it("keeps pull-request state current when only the Build OS read fails", async () => {
    const ledger = new InMemoryEventLedger();
    const good = new FixtureGitHub([observation(1)]);
    const brokenBuildOs: GitHubPort = {
      observe: (repo, options) => good.observe(repo, options),
      listPaths: (repo, directory) => good.listPaths(repo, directory),
      readFile: (repo, path) => {
        if (path.endsWith("ACTIVE.md")) throw new GitHubApiError("500 Internal Server Error", 500);
        return good.readFile(repo, path);
      },
    };

    const result = await syncProject({
      project: testProject(),
      github: brokenBuildOs,
      ledger,
      ownerLogin: OWNER,
      now: NOW,
    });

    // The whole cycle is not a failure: GitHub answered, and that is what `syncFailed` reports.
    expect(result.syncFailed).toBeUndefined();
    // The fact this bug destroyed: pull requests still project from the events that did arrive.
    expect(result.state.pullRequests).toHaveLength(3);
    const pullRequestCards = result.cards.filter((c) => c.entityType === "PULL_REQUEST");
    expect(pullRequestCards.length).toBeGreaterThan(0);
    expect(pullRequestCards.every((c) => c.currentState !== "No current state recorded.")).toBe(true);
    // The failure is not swallowed either — it is visible as its own event, distinct from a
    // GitHub-reachability failure, so a repeated one is diagnosable.
    const failure = result.appended.find(
      (e) => e.eventType === "SYNC_FAILED" && e.summaryShort.includes("Build OS"),
    );
    expect(failure).toBeDefined();
    expect(failure!.summaryShort).toContain("500");
  });

  it("shows an agent's claim and GitHub's state separately when they disagree", async () => {
    const ledger = new InMemoryEventLedger();

    // The agent says it finished; GitHub says the PR is open with failing CI.
    const claimsDone = { ...sessionFrom("valid-active.json"), status: "COMPLETED" as const };

    const result = await syncProject({
      project: testProject(),
      github: new FixtureGitHub([observation(2)]),
      ledger,
      ownerLogin: OWNER,
      now: NOW,
      sessions: [claimsDone],
    });

    const pr84 = result.state.pullRequests.find((p) => p.number === 84)!;
    expect(pr84.lifecycle).toBe("OPEN");
    expect(pr84.ciState).toBe("FAILED");
    expect(result.state.sessions[0]!.status).toBe("COMPLETED");

    // GitHub wins for attention: a completed session is not active remediation.
    expect(result.attention.some((a) => a.reasonCode === "PR_CI_FAILED")).toBe(true);
  });

  it("surfaces Build OS integrity problems from the real fixtures", async () => {
    const result = await syncProject({
      project: testProject(),
      github: new FixtureGitHub([observation(1)]),
      ledger: new InMemoryEventLedger(),
      ownerLogin: OWNER,
      now: NOW,
    });

    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain("BOARD_FILE_PHASE_MISMATCH");
    expect(codes).toContain("BOARD_ROW_WITHOUT_FILE");
  });

  it("skips Build OS parsing for a repository that does not use it", async () => {
    const result = await syncProject({
      project: testProject({ buildOsDetected: false }),
      github: new FixtureGitHub([observation(1)]),
      ledger: new InMemoryEventLedger(),
      ownerLogin: OWNER,
      now: NOW,
    });

    expect(result.state.workstreams).toHaveLength(0);
    // Still useful: the GitHub feed works without Build OS.
    expect(result.cards.length).toBeGreaterThan(0);
  });

  it("puts a session blocked on the owner into Needs Me", async () => {
    const result = await syncProject({
      project: testProject(),
      github: new FixtureGitHub([observation(1)]),
      ledger: new InMemoryEventLedger(),
      ownerLogin: OWNER,
      now: NOW,
      sessions: [sessionFrom("blocked-on-owner.json")],
    });

    expect(result.attention.some((a) => a.reasonCode === "SESSION_BLOCKED" && a.severity === "HIGH")).toBe(
      true,
    );
  });
});
