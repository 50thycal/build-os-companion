/**
 * What discovery does to the *followed set*, and what a card says once it is followed.
 *
 * Two halves of the same dogfood pass. The first is about which projects exist at all — the
 * ageing rule, and the promise that a failed discovery never empties the feed. The second is
 * about the sentences the owner reads once a project is there, which is where the stale-state
 * defects lived.
 */

import { describe, expect, it } from "vitest";
import { applyConfig, parseConfig } from "../src/config/followed.ts";
import { openDatabase } from "../src/store/database.ts";
import { CompanionStore } from "../src/store/store.ts";
import { buildFeed } from "../src/feed/cards.ts";
import { describePullRequestStanding } from "../src/domain/describe.ts";
import { checkReviewGate } from "../src/projection/review-gate.ts";
import type { DiscoveredRepository } from "../src/ingest/github/discovery.ts";
import type {
  CompanionEvent,
  EventType,
} from "../src/domain/events.ts";
import type { ProjectState, PullRequestState, WorkstreamState } from "../src/domain/state.ts";
import type { SourceRef } from "../src/domain/provenance.ts";

const NOW = new Date("2026-08-28T12:00:00Z");

const SOURCE: SourceRef = {
  sourceType: "GITHUB_STATE",
  sourceId: "pr:146",
  observedAt: "2026-08-28T11:00:00Z",
};

function config(overrides: Record<string, unknown> = {}) {
  return parseConfig({ ownerLogin: "50thycal", projects: [], ...overrides });
}

function found(fullName: string): DiscoveredRepository {
  return {
    fullName,
    defaultBranch: "main",
    pushedAt: "2026-08-27T00:00:00Z",
    private: false,
    fork: false,
    archived: false,
    signal: "OWNER_COMMITS",
    attributed: true,
    evidence: "3 commits authored by 50thycal since 2026-06-29",
  };
}

function store() {
  return new CompanionStore(openDatabase({ location: ":memory:" }));
}

describe("the followed set", () => {
  it("follows what discovery found, with the evidence attached", () => {
    const s = store();
    applyConfig(s, config(), NOW, { discovered: [found("50thycal/kalshi_bot")], discoveryRan: true });

    const [project] = s.listProjects();
    expect(project!.repositoryFullName).toBe("50thycal/kalshi_bot");
    expect(project!.discoverySignal).toBe("OWNER_COMMITS");
    expect(project!.discoveryEvidence).toContain("3 commits");
  });

  it("ages a project out when it leaves the window, keeping its rows", () => {
    const s = store();
    applyConfig(s, config(), NOW, { discovered: [found("50thycal/quiet")], discoveryRan: true });
    applyConfig(s, config(), NOW, { discovered: [], discoveryRan: true });

    expect(s.listProjects()).toEqual([]);
    // Disabled, never deleted: the history is still true.
    expect(s.listProjects({ includeDisabled: true }).map((p) => p.repositoryFullName)).toEqual([
      "50thycal/quiet",
    ]);
  });

  it("ages nothing out on a cycle where discovery could not answer", () => {
    const s = store();
    applyConfig(s, config(), NOW, { discovered: [found("50thycal/kalshi_bot")], discoveryRan: true });
    // A failed listing is not evidence that the owner stopped working.
    applyConfig(s, config(), NOW);

    expect(s.listProjects().map((p) => p.repositoryFullName)).toEqual(["50thycal/kalshi_bot"]);
  });

  it("keeps a pin the window would never have found", () => {
    const s = store();
    applyConfig(s, config({ projects: [{ repository: "50thycal/townle" }] }), NOW, {
      discovered: [],
      discoveryRan: true,
    });

    expect(s.listProjects().map((p) => p.repositoryFullName)).toEqual(["50thycal/townle"]);
    expect(s.listProjects()[0]!.discoverySignal).toBe("PINNED");
  });

  it("reads a config with no projects at all", () => {
    // The file is exceptions to a rule now, and having no exceptions is normal.
    expect(config().projects).toEqual([]);
    expect(config().discovery.lookbackDays).toBe(60);
  });

  it("takes the lookback and the exclusions from the config", () => {
    const parsed = config({ discovery: { lookbackDays: 30, exclude: ["50thycal/noisy"] } });
    expect(parsed.discovery.lookbackDays).toBe(30);
    expect(parsed.discovery.exclude).toEqual(["50thycal/noisy"]);
  });
});

// ---------------------------------------------------------------------------

function pull(overrides: Partial<PullRequestState> = {}): PullRequestState {
  return {
    projectId: "p",
    number: 146,
    title: "Close the loop",
    lifecycle: "MERGED",
    draft: false,
    headBranch: "claude/ws-003",
    headSha: "a".repeat(40),
    baseBranch: "main",
    author: "50thycal",
    createdAt: "2026-08-28T05:00:00Z",
    updatedAt: "2026-08-28T11:43:00Z",
    mergedAt: "2026-08-28T11:43:00Z",
    mergeability: "UNKNOWN",
    reviewState: "NONE",
    ciState: "PASSED",
    requestedReviewers: [],
    approvedHeadShas: [],
    ownerAcceptances: [],
    // A pull request that carries a review of some kind, which is what these fixtures mean by a
    // reviewed PR. Zero is its own case — a file claiming a verdict nothing outside it records —
    // and is set explicitly by the tests for it.
    recordedPositions: 1,
    changesRequestedBy: [],
    mutatedEvidence: [],
    workstreamIds: [],
    sourceUrl: "https://github.com/50thycal/party-games/pull/146",
    source: SOURCE,
    ...overrides,
  };
}

describe("a settled pull request stops asking for review", () => {
  it("leads with the merge, and puts the pre-merge facts in the past tense", () => {
    const text = describePullRequestStanding(pull(), NOW);
    expect(text).toContain("Merged 17 min ago into main");
    expect(text).not.toContain("no review yet");
    // The fact that nobody reviewed it is kept — it is what the merge gate cares about.
    expect(text).toContain("no review was recorded");
  });

  it("is unmistakably different when it closed without merging", () => {
    const text = describePullRequestStanding(
      pull({ lifecycle: "CLOSED", mergedAt: undefined, closedAt: "2026-08-28T11:43:00Z" }),
      NOW,
    );
    expect(text).toContain("Closed 17 min ago without merging");
    expect(text).toContain("nothing from it reached main");
  });

  it("still reports review as outstanding while the pull request is open", () => {
    const text = describePullRequestStanding(
      pull({ lifecycle: "OPEN", mergedAt: undefined, ciState: "PASSED" }),
      NOW,
    );
    expect(text).toBe("checks green, no review yet.");
  });
});

// ---------------------------------------------------------------------------

function event(overrides: Partial<CompanionEvent> & { eventType: EventType; id: string }): CompanionEvent {
  return {
    projectId: "p",
    source: SOURCE,
    actor: { type: "AGENT", name: "50thycal" },
    occurredAt: "2026-08-28T11:00:00Z",
    ingestedAt: "2026-08-28T11:00:00Z",
    importance: "NOTABLE",
    summaryShort: "something",
    sourceFingerprint: overrides.id,
    ...overrides,
  } as CompanionEvent;
}

function emptyState(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    projectId: "p",
    pullRequests: [],
    workstreams: [],
    sessions: [],
    decisions: [],
    integrityWarnings: [],
    conflicts: [],
    ...overrides,
  };
}

describe("collapsing describes the outcome, not the concatenation", () => {
  const events = [
    event({
      id: "evt_open",
      eventType: "PR_OPENED",
      occurredAt: "2026-08-28T05:00:00Z",
      pullRequestNumber: 146,
      summaryShort: "PR #146 opened: Close the loop",
    }),
    event({
      id: "evt_merge",
      eventType: "PR_MERGED",
      importance: "MAJOR",
      occurredAt: "2026-08-28T11:43:00Z",
      pullRequestNumber: 146,
      summaryShort: "PR #146 merged: Close the loop",
    }),
  ];

  const cards = () =>
    buildFeed({
      projectId: "p",
      projectName: "Party Games",
      state: emptyState({ pullRequests: [pull()] }),
      events,
      attention: [],
      now: NOW,
    });

  it("headlines the latest meaningful outcome", () => {
    expect(cards()[0]!.whatChanged).toBe("PR #146 merged: Close the loop");
  });

  it("never says 'Also: PR #146 opened'", () => {
    expect(cards()[0]!.whatChanged).not.toContain("Also");
  });

  it("keeps the earlier events as a subordinate trail, oldest first", () => {
    expect(cards()[0]!.history).toBe("Opened 7 h ago; merged 17 min ago.");
  });

  it("collapses repeated churn of one kind into its latest occurrence", () => {
    const noisy = [
      ...events,
      event({ id: "evt_u1", eventType: "PR_UPDATED", importance: "ROUTINE", occurredAt: "2026-08-28T06:00:00Z", pullRequestNumber: 146 }),
      event({ id: "evt_u2", eventType: "PR_UPDATED", importance: "ROUTINE", occurredAt: "2026-08-28T07:00:00Z", pullRequestNumber: 146 }),
    ];
    const card = buildFeed({
      projectId: "p",
      projectName: "Party Games",
      state: emptyState({ pullRequests: [pull()] }),
      events: noisy,
      attention: [],
      now: NOW,
    })[0]!;

    expect(card.history).toBe("Opened 7 h ago; updated 5 h ago; merged 17 min ago.");
  });

  it("says nothing about history when only one thing happened", () => {
    const card = buildFeed({
      projectId: "p",
      projectName: "Party Games",
      state: emptyState({ pullRequests: [pull()] }),
      events: [events[1]!],
      attention: [],
      now: NOW,
    })[0]!;

    expect(card.history).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

function workstream(overrides: Partial<WorkstreamState> = {}): WorkstreamState {
  return {
    projectId: "p",
    workstreamId: "WS-003",
    title: "Subway construction access",
    phase: "READY_TO_BUILD",
    status: "BLOCKED",
    nextStep: "Blocked: merge PR #146 first, then begin implementation",
    blocker: "merge PR #146 first, then begin implementation",
    openDecisions: [],
    relatedPrNumbers: [146],
    relatedDecisionIds: [],
    buildCardReady: true,
    reviewRecords: [],
    protocolVersion: "v0.5",
    protocolVersionSource: "WORKSTREAM",
    updatedAt: "2026-08-26",
    sourcePath: "docs/workstreams/WS-003.md",
    source: { ...SOURCE, sourceType: "BUILD_OS_ARTIFACT", sourceId: "docs/workstreams/WS-003.md" },
    conflicts: [],
    ...overrides,
  };
}

describe("a durable record behind GitHub becomes a finding, not a correction", () => {
  const codes = (ws: WorkstreamState, prs: PullRequestState[]) =>
    checkReviewGate([ws], prs).map((w) => w.code);

  it("reports a workstream still in READY_TO_BUILD whose implementation has merged", () => {
    const found = codes(workstream(), [pull()]);
    expect(found).toContain("WORKSTREAM_STATE_BEHIND_GITHUB");
  });

  it("reports a blocker naming a pull request that has already merged", () => {
    const warnings = checkReviewGate([workstream()], [pull()]);
    const resolved = warnings.find((w) => w.code === "BLOCKER_ALREADY_RESOLVED");
    expect(resolved?.message).toContain("PR #146");
    expect(resolved?.message).toContain("already met");
  });

  it("stays silent while any linked pull request is still open", () => {
    // A workstream in BUILDING with a merged design-only PR and an open implementation PR is
    // exactly where it says it is. Firing here would make the finding worthless.
    const ws = workstream({ phase: "BUILDING", status: "ACTIVE", blocker: undefined, nextStep: "Implement", relatedPrNumbers: [143, 146] });
    const open = pull({ number: 143, lifecycle: "OPEN", mergedAt: undefined, source: { ...SOURCE, sourceId: "pr:143" } });
    expect(codes(ws, [open, pull()])).not.toContain("WORKSTREAM_STATE_BEHIND_GITHUB");
  });

  it("never rewrites the durable phase to agree with GitHub", () => {
    // The card still reports what the artifact says. The disagreement is a third output.
    const ws = workstream();
    const state = emptyState({
      pullRequests: [pull({ workstreamIds: ["WS-003"] })],
      workstreams: [ws],
      integrityWarnings: checkReviewGate([ws], [pull()]),
    });

    const card = buildFeed({
      projectId: "p",
      projectName: "Party Games",
      state,
      events: [event({ id: "evt_ws", eventType: "WORKSTREAM_BLOCKED", workstreamId: "WS-003", summaryShort: "WS-003 is blocked" })],
      attention: [],
      now: NOW,
    })[0]!;

    expect(card.currentState).toContain("ready to build, blocked");
    expect(card.contradictions?.join(" ")).toContain("already merged");
  });
});

