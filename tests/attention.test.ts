/**
 * Table-driven attention scenarios.
 *
 * These encode the product's promise: `Needs Me` fires on things that genuinely need the owner
 * and stays quiet on healthy autonomous work. Every case names both the expected reason code and
 * the expected severity, because a rule that fires for the wrong reason is still wrong.
 */

import { describe, expect, it } from "vitest";

import { computeAttention, needsMe } from "../src/attention/engine.ts";
import { DEFAULT_THRESHOLDS } from "../src/domain/attention.ts";
import type {
  ProjectState,
  PullRequestState,
  SessionState,
  WorkstreamState,
} from "../src/domain/state.ts";

const NOW = new Date("2026-08-23T18:00:00Z");
const OWNER = "50thycal";
const PROJECT = "proj_cargo_ship";

const SOURCE = {
  sourceType: "GITHUB_STATE" as const,
  sourceId: "pr:84",
  sourceUrl: "https://github.com/50thycal/cargo-ship/pull/84",
  observedAt: NOW.toISOString(),
};

function pullRequest(overrides: Partial<PullRequestState> = {}): PullRequestState {
  return {
    projectId: PROJECT,
    number: 84,
    title: "Region-aware simulation",
    lifecycle: "OPEN",
    draft: false,
    headBranch: "claude/regions",
    baseBranch: "main",
    author: OWNER,
    createdAt: "2026-08-21T09:00:00Z",
    updatedAt: "2026-08-23T17:00:00Z",
    mergeability: "CLEAN",
    reviewState: "NONE",
    ciState: "PASSED",
    requestedReviewers: [],
    workstreamIds: [],
    sourceUrl: SOURCE.sourceUrl!,
    source: SOURCE,
    ...overrides,
  };
}

function workstream(overrides: Partial<WorkstreamState> = {}): WorkstreamState {
  return {
    projectId: PROJECT,
    workstreamId: "WS-001",
    title: "Procurement redesign",
    phase: "BUILDING",
    status: "ACTIVE",
    openDecisions: [],
    relatedPrNumbers: [],
    relatedDecisionIds: [],
    buildCardReady: true,
    updatedAt: "2026-08-23T09:00:00Z",
    sourcePath: "docs/workstreams/WS-001-procurement-redesign.md",
    source: { ...SOURCE, sourceType: "BUILD_OS_ARTIFACT", sourceId: "WS-001" },
    conflicts: [],
    ...overrides,
  };
}

function session(overrides: Partial<SessionState> = {}): SessionState {
  return {
    projectId: PROJECT,
    sessionId: "claude-1",
    agent: "claude",
    sessionKind: "IMPLEMENTATION",
    objective: "Add region-aware simulation",
    status: "ACTIVE",
    startedAt: "2026-08-23T15:00:00Z",
    updatedAt: "2026-08-23T17:45:00Z",
    completed: [],
    inProgress: ["Balancing simulation"],
    blockers: [],
    checkpointSource: "API",
    stale: false,
    ...overrides,
  };
}

function state(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    projectId: PROJECT,
    pullRequests: [],
    workstreams: [],
    sessions: [],
    decisions: [],
    integrityWarnings: [],
    conflicts: [],
    ...overrides,
  };
}

function run(s: ProjectState) {
  return computeAttention({ state: s, ownerLogin: OWNER, now: NOW, thresholds: DEFAULT_THRESHOLDS });
}

describe("attention: things that must NOT reach the owner", () => {
  it("PR green + agent active + no blocker -> nothing needed", () => {
    const items = run(
      state({
        pullRequests: [pullRequest()],
        sessions: [session({ relatedPrNumber: 84 })],
      }),
    );
    expect(needsMe(items)).toHaveLength(0);
    expect(items.every((i) => i.severity === "NONE")).toBe(true);
  });

  it("CI failing while an agent is on it -> suppressed, and says why", () => {
    const items = run(
      state({
        pullRequests: [pullRequest({ ciState: "FAILED" })],
        sessions: [session({ relatedPrNumber: 84 })],
      }),
    );
    expect(needsMe(items)).toHaveLength(0);

    const suppression = items.find((i) => i.entityId === "pr:84")!;
    expect(suppression.reasonCode).toBe("AUTONOMOUS_PROGRESS");
    expect(suppression.reasonText).toContain("CI is failing");
    expect(suppression.reasonText).toContain("actively working");
  });

  it("agent resolving review comments -> suppressed", () => {
    const items = run(
      state({
        pullRequests: [pullRequest({ reviewState: "CHANGES_REQUESTED" })],
        sessions: [session({ relatedPrNumber: 84 })],
      }),
    );
    expect(needsMe(items)).toHaveLength(0);
  });

  it("intentionally paused workstream -> never reported as stale", () => {
    const items = run(
      state({
        workstreams: [
          workstream({
            status: "PAUSED",
            updatedAt: "2026-06-01T00:00:00Z",
            openDecisions: [{ key: "D1", question: "Deferred until we resume" }],
          }),
        ],
      }),
    );
    expect(needsMe(items)).toHaveLength(0);
    expect(items[0]!.reasonCode).toBe("AUTONOMOUS_PROGRESS");
    expect(items[0]!.reasonText).toContain("paused on purpose");
  });

  it("CI still running -> not an owner problem", () => {
    const items = run(state({ pullRequests: [pullRequest({ ciState: "RUNNING" })] }));
    expect(needsMe(items)).toHaveLength(0);
  });

  it("merged PR -> produces no attention at all", () => {
    const items = run(
      state({
        pullRequests: [pullRequest({ lifecycle: "MERGED", ciState: "FAILED", mergeability: "CONFLICTED" })],
      }),
    );
    expect(items).toHaveLength(0);
  });
});

describe("attention: things that MUST reach the owner", () => {
  it("changes requested with nobody acting -> HIGH", () => {
    const items = needsMe(
      run(state({ pullRequests: [pullRequest({ reviewState: "CHANGES_REQUESTED" })] })),
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.reasonCode).toBe("REVIEW_CHANGES_REQUESTED");
    expect(items[0]!.severity).toBe("HIGH");
  });

  it("owner decision open on an active workstream -> HIGH, naming the question", () => {
    const items = needsMe(
      run(
        state({
          workstreams: [
            workstream({
              phase: "DECIDE",
              openDecisions: [{ key: "D3", question: "Does the card return to the deck?" }],
            }),
          ],
        }),
      ),
    );
    expect(items[0]!.reasonCode).toBe("OWNER_DECISION_REQUIRED");
    expect(items[0]!.reasonText).toContain("Does the card return to the deck?");
  });

  it("PR changes requested AND an owner decision -> both surface, highest first", () => {
    const items = needsMe(
      run(
        state({
          pullRequests: [pullRequest({ reviewState: "CHANGES_REQUESTED" })],
          workstreams: [
            workstream({ openDecisions: [{ key: "D1", question: "Which pricing model?" }] }),
          ],
        }),
      ),
    );
    expect(items.map((i) => i.reasonCode).sort()).toEqual([
      "OWNER_DECISION_REQUIRED",
      "REVIEW_CHANGES_REQUESTED",
    ]);
    expect(items.every((i) => i.severity === "HIGH")).toBe(true);
  });

  it("failed CI with no active remediation -> HIGH", () => {
    const items = needsMe(run(state({ pullRequests: [pullRequest({ ciState: "FAILED" })] })));
    expect(items[0]!.reasonCode).toBe("PR_CI_FAILED");
  });

  it("a stale agent session does not count as active remediation", () => {
    const items = needsMe(
      run(
        state({
          pullRequests: [pullRequest({ ciState: "FAILED" })],
          sessions: [session({ relatedPrNumber: 84, status: "UNKNOWN", stale: true })],
        }),
      ),
    );
    expect(items.map((i) => i.reasonCode)).toContain("PR_CI_FAILED");
  });

  it("PR waiting on the owner's review -> HIGH", () => {
    const items = needsMe(
      run(
        state({
          pullRequests: [
            pullRequest({ reviewState: "REVIEW_REQUESTED", requestedReviewers: [OWNER] }),
          ],
        }),
      ),
    );
    expect(items[0]!.reasonCode).toBe("PR_WAITING_FOR_OWNER_REVIEW");
  });

  it("PR waiting on somebody else's review -> not the owner's problem", () => {
    const items = needsMe(
      run(
        state({
          pullRequests: [
            pullRequest({ reviewState: "REVIEW_REQUESTED", requestedReviewers: ["someone-else"] }),
          ],
        }),
      ),
    );
    expect(items).toHaveLength(0);
  });

  it("Build Card awaiting approval -> HIGH", () => {
    const items = needsMe(run(state({ workstreams: [workstream({ phase: "BUILD_CARD" })] })));
    expect(items[0]!.reasonCode).toBe("BUILD_CARD_AWAITING_APPROVAL");
  });

  it("merge conflict with nobody on it -> HIGH", () => {
    const items = needsMe(
      run(state({ pullRequests: [pullRequest({ mergeability: "CONFLICTED" })] })),
    );
    expect(items[0]!.reasonCode).toBe("MERGE_CONFLICT");
  });

  it("session blocked on the owner -> HIGH; blocked on something else -> not in Needs Me", () => {
    const onOwner = needsMe(
      run(
        state({
          sessions: [
            session({
              status: "BLOCKED",
              blockers: [{ description: "Prize-payout rules are undecided", needsOwner: true }],
            }),
          ],
        }),
      ),
    );
    expect(onOwner[0]!.reasonCode).toBe("SESSION_BLOCKED");
    expect(onOwner[0]!.severity).toBe("HIGH");

    const onSomethingElse = needsMe(
      run(
        state({
          sessions: [
            session({
              status: "BLOCKED",
              blockers: [{ description: "Waiting for a nightly build", needsOwner: false }],
            }),
          ],
        }),
      ),
    );
    expect(onSomethingElse).toHaveLength(0);
  });

  it("a session that stopped checkpointing -> MEDIUM, described as unknown", () => {
    const items = needsMe(
      run(state({ sessions: [session({ status: "UNKNOWN", stale: true })] })),
    );
    expect(items[0]!.reasonCode).toBe("SESSION_STALE");
    expect(items[0]!.reasonText).toContain("unknown");
  });

  it("workstream blocked on the owner outranks one blocked on something else", () => {
    const blockedOnOwner = run(
      state({
        workstreams: [workstream({ status: "BLOCKED", blocker: "Needs a payout decision" })],
        sessions: [
          session({
            workstreamId: "WS-001",
            status: "BLOCKED",
            blockers: [{ description: "Needs a payout decision", needsOwner: true }],
          }),
        ],
      }),
    ).find((i) => i.reasonCode === "WORKSTREAM_BLOCKED")!;

    const blockedOnOther = run(
      state({ workstreams: [workstream({ status: "BLOCKED", blocker: "Waiting on WS-002" })] }),
    ).find((i) => i.reasonCode === "WORKSTREAM_BLOCKED")!;

    expect(blockedOnOwner.severity).toBe("HIGH");
    expect(blockedOnOwner.reasonText).toContain("blocked on you");
    expect(blockedOnOther.severity).toBe("MEDIUM");
  });

  it("an active workstream nobody has touched for weeks -> MEDIUM", () => {
    const items = needsMe(
      run(state({ workstreams: [workstream({ updatedAt: "2026-07-01T00:00:00Z" })] })),
    );
    expect(items[0]!.reasonCode).toBe("WORKSTREAM_STALE");
  });

  it("a stalled PR with nothing else wrong -> MEDIUM", () => {
    const items = needsMe(
      run(state({ pullRequests: [pullRequest({ updatedAt: "2026-08-15T00:00:00Z" })] })),
    );
    expect(items[0]!.reasonCode).toBe("PR_STALE");
  });
});

describe("attention: explainability", () => {
  it("gives every item a reason code, a sentence, an action, and evidence", () => {
    const items = run(
      state({
        pullRequests: [pullRequest({ ciState: "FAILED" })],
        workstreams: [workstream({ openDecisions: [{ key: "D1", question: "Which model?" }] })],
        sessions: [session()],
      }),
    );

    for (const item of items) {
      expect(item.reasonCode).toBeTruthy();
      expect(item.reasonText.length).toBeGreaterThan(10);
      expect(item.recommendedAction.length).toBeGreaterThan(0);
      expect(item.evidence.length).toBeGreaterThan(0);
    }
  });

  it("is deterministic: same state and clock, same items and ids", () => {
    const s = state({
      pullRequests: [pullRequest({ ciState: "FAILED" })],
      workstreams: [workstream({ openDecisions: [{ key: "D1", question: "Which model?" }] })],
    });
    expect(run(s)).toEqual(run(s));
  });

  it("orders by severity so the worst thing is first", () => {
    const items = run(
      state({
        pullRequests: [
          pullRequest({ ciState: "FAILED" }),
          pullRequest({ number: 91, updatedAt: "2026-08-15T00:00:00Z", source: { ...SOURCE, sourceId: "pr:91" } }),
        ],
      }),
    );
    expect(items[0]!.severity).toBe("HIGH");
  });

  it("surfaces Build OS integrity problems without shouting about them", () => {
    const items = run(
      state({
        integrityWarnings: [
          {
            code: "BOARD_FILE_PHASE_MISMATCH",
            workstreamId: "WS-003",
            message: "WS-003 disagrees between the board and its file.",
            sources: [SOURCE],
          },
        ],
      }),
    );
    const integrity = items.find((i) => i.reasonCode === "BUILD_OS_INTEGRITY")!;
    expect(integrity.severity).toBe("LOW");
    expect(needsMe(items)).toHaveLength(0);
  });
});
