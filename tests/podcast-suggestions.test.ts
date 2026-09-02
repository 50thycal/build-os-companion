/**
 * Podcast topic suggestions: what earns an episode, what does not, and what happens when the
 * owner decides.
 *
 * The promise being tested is editorial selectivity. A page that proposes an episode about every
 * merged pull request is worse than no page, so the cases that assert *silence* matter as much as
 * the ones that assert a suggestion — and every suggestion has to be able to say why it exists.
 */

import { describe, expect, it } from "vitest";

import { openSuggestions, suggestTopics } from "../src/podcast/suggest.ts";
import { DEFAULT_SUGGESTION_THRESHOLDS } from "../src/domain/podcast-suggestion.ts";
import type { DecisionRecord, ProjectState, PullRequestState, WorkstreamState } from "../src/domain/state.ts";
import { openDatabase } from "../src/store/database.ts";
import { CompanionStore } from "../src/store/store.ts";
import { SqliteEventLedger } from "../src/ledger/sqlite-ledger.ts";
import { CompanionApp } from "../src/app/companion-app.ts";
import { durableSync } from "../src/sync/durable-sync.ts";
import { livePartyGamesPort, PARTY_GAMES } from "./live-port.ts";

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
    lifecycle: "MERGED",
    draft: false,
    headSha: "1f4b0c9a7d2e6538ab41cc90de77315268b0aa42",
    headBranch: "claude/regions",
    baseBranch: "main",
    author: OWNER,
    createdAt: "2026-08-21T09:00:00Z",
    updatedAt: "2026-08-23T17:00:00Z",
    mergedAt: "2026-08-23T17:00:00Z",
    mergeability: "CLEAN",
    reviewState: "NONE",
    ciState: "PASSED",
    requestedReviewers: [],
    approvedHeadShas: [],
    ownerAcceptances: [],
    recordedPositions: 1,
    changesRequestedBy: [],
    mutatedEvidence: [],
    workstreamIds: ["WS-001"],
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
    goal: "Buying a ship should take one screen, not four.",
    phase: "BUILDING",
    status: "ACTIVE",
    openDecisions: [],
    relatedPrNumbers: [],
    relatedDecisionIds: [],
    buildCardReady: true,
    reviewRecords: [],
    updatedAt: "2026-08-23T09:00:00Z",
    sourcePath: "docs/workstreams/WS-001-procurement-redesign.md",
    source: { ...SOURCE, sourceType: "BUILD_OS_ARTIFACT", sourceId: "WS-001" },
    conflicts: [],
    ...overrides,
  };
}

function decision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    projectId: PROJECT,
    decisionId: "DEC-001",
    title: "Procurement is a plugin, not a screen",
    status: "ACCEPTED",
    sourcePath: "docs/DECISIONS.md",
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

const run = (s: ProjectState) => suggestTopics({ state: s, projectName: "Cargo Ship", now: NOW });

/** What would actually be shown: above the bar, capped, nothing already decided. */
const shown = (s: ProjectState) => openSuggestions(run(s), new Set());

const prs = (numbers: number[]) =>
  numbers.map((number) => pullRequest({ number, title: `Change ${number}`, mergedAt: `2026-08-2${number % 9}T10:00:00Z` }));

describe("things that must NOT be suggested", () => {
  it("a single merged pull request -> nothing", () => {
    const s = state({
      workstreams: [workstream({ relatedPrNumbers: [84] })],
      pullRequests: [pullRequest()],
    });

    expect(shown(s)).toHaveLength(0);
  });

  it("routine progress below the narrative bar -> recorded as considered, and says why", () => {
    const s = state({
      workstreams: [workstream({ relatedPrNumbers: [84, 85] })],
      pullRequests: prs([84, 85]),
    });

    expect(shown(s)).toHaveLength(0);

    const rejected = run(s).find((c) => c.reasonCode === "NOT_WORTH_AN_EPISODE");
    expect(rejected).toBeDefined();
    expect(rejected!.scoreReasons.join(" ")).toContain("routine work");
  });

  it("a workstream that closed with nothing behind it -> considered and rejected", () => {
    const s = state({ workstreams: [workstream({ phase: "COMPLETE", status: "COMPLETE" })] });

    expect(shown(s)).toHaveLength(0);
    const rejected = run(s).find((c) => c.reasonCode === "NOT_WORTH_AN_EPISODE");
    expect(rejected!.scoreReasons.join(" ")).toContain("no story arc");
  });

  it("an abandoned workstream produces nothing at all, not even a rejection", () => {
    const s = state({
      workstreams: [workstream({ status: "ABANDONED", relatedPrNumbers: [84, 85, 86] })],
      pullRequests: prs([84, 85, 86]),
    });

    expect(run(s)).toHaveLength(0);
  });

  it("never proposes more than the cap, however much has happened", () => {
    const many = [1, 2, 3, 4, 5].map((n) =>
      workstream({
        workstreamId: `WS-00${n}`,
        title: `Workstream ${n}`,
        phase: "COMPLETE",
        status: "COMPLETE",
        relatedPrNumbers: [84, 85, 86],
        relatedDecisionIds: ["DEC-001", "DEC-002"],
      }),
    );
    const s = state({
      workstreams: many,
      pullRequests: prs([84, 85, 86]).map((pr) => ({ ...pr, workstreamIds: many.map((w) => w.workstreamId) })),
      decisions: [decision(), decision({ decisionId: "DEC-002", title: "Ships are plugins" })],
    });

    expect(shown(s).length).toBeLessThanOrEqual(DEFAULT_SUGGESTION_THRESHOLDS.maximumOpen);
  });
});

describe("things that MUST be suggested", () => {
  it("a completed workstream with decisions and merges -> WORKSTREAM_COMPLETED", () => {
    const s = state({
      workstreams: [
        workstream({
          phase: "COMPLETE",
          status: "COMPLETE",
          relatedPrNumbers: [84, 85],
          relatedDecisionIds: ["DEC-001", "DEC-002"],
        }),
      ],
      pullRequests: prs([84, 85]),
      decisions: [decision(), decision({ decisionId: "DEC-002", title: "Ships are plugins" })],
    });

    const [top] = shown(s);
    expect(top!.reasonCode).toBe("WORKSTREAM_COMPLETED");
    expect(top!.title).toContain("Procurement redesign");
    // The goal it set out to achieve is what an explainer opens on.
    expect(top!.whatYouWouldLearn.join(" ")).toContain("one screen, not four");
  });

  it("several merged pull requests on live work -> PR_NARRATIVE", () => {
    const s = state({
      workstreams: [workstream({ relatedPrNumbers: [84, 85, 86] })],
      pullRequests: prs([84, 85, 86]),
    });

    const suggestion = shown(s).find((x) => x.reasonCode === "PR_NARRATIVE");
    expect(suggestion).toBeDefined();
    expect(suggestion!.title).toContain("3 pull requests");
  });

  it("a cluster of accepted decisions -> DECISION_CLUSTER", () => {
    const s = state({
      workstreams: [workstream({ relatedDecisionIds: ["DEC-001", "DEC-002"] })],
      decisions: [decision(), decision({ decisionId: "DEC-002", title: "Ships are plugins" })],
    });

    const suggestion = shown(s).find((x) => x.reasonCode === "DECISION_CLUSTER");
    expect(suggestion).toBeDefined();
    expect(suggestion!.whatYouWouldLearn).toHaveLength(2);
  });

  it("open decisions nobody has answered -> OPEN_TRADEOFF, ranked below finished arcs", () => {
    const s = state({
      workstreams: [
        workstream({
          openDecisions: [
            { key: "D1", question: "Do regions own pricing?" },
            { key: "D2", question: "Is procurement per-port?" },
          ],
        }),
        workstream({
          workstreamId: "WS-002",
          title: "Route engineering",
          phase: "COMPLETE",
          status: "COMPLETE",
          relatedPrNumbers: [84, 85],
          relatedDecisionIds: ["DEC-001", "DEC-002"],
        }),
      ],
      pullRequests: prs([84, 85]).map((pr) => ({ ...pr, workstreamIds: ["WS-002"] })),
      decisions: [decision(), decision({ decisionId: "DEC-002", title: "Ships are plugins" })],
    });

    const list = shown(s);
    const tradeoff = list.findIndex((x) => x.reasonCode === "OPEN_TRADEOFF");
    const finished = list.findIndex((x) => x.reasonCode === "WORKSTREAM_COMPLETED");
    expect(tradeoff).toBeGreaterThan(-1);
    expect(finished).toBeLessThan(tradeoff);
  });
});

describe("explainability and determinism", () => {
  const rich = state({
    workstreams: [
      workstream({
        phase: "COMPLETE",
        status: "COMPLETE",
        relatedPrNumbers: [84, 85],
        relatedDecisionIds: ["DEC-001", "DEC-002"],
      }),
    ],
    pullRequests: prs([84, 85]),
    decisions: [decision(), decision({ decisionId: "DEC-002", title: "Ships are plugins" })],
  });

  it("every suggestion explains itself and cites what it was built from", () => {
    for (const suggestion of run(rich)) {
      expect(suggestion.reasonCode).toBeTruthy();
      expect(suggestion.whyNow.length).toBeGreaterThan(10);
      expect(suggestion.scoreReasons.length).toBeGreaterThan(0);
      expect(suggestion.refs.length).toBeGreaterThan(0);
      expect(suggestion.evidence.length).toBeGreaterThan(0);
      for (const ref of suggestion.refs) expect(ref.projectId).toBe(PROJECT);
    }
  });

  it("marks its own editorial judgment as an inference, not as an observation", () => {
    const suggestion = shown(rich)[0]!;
    const kinds = suggestion.evidence.map((e) => e.sourceType);
    expect(kinds).toContain("INFERENCE");
    // The artifacts it read are not inferences, and must not be relabelled as such.
    expect(kinds).toContain("BUILD_OS_ARTIFACT");
  });

  it("is deterministic: same state and clock, same suggestions and ids", () => {
    expect(run(rich)).toEqual(run(rich));
  });

  it("gives one workstream separate ids for separate reasons, so dismissing one keeps the other", () => {
    const s = state({
      workstreams: [
        workstream({
          relatedPrNumbers: [84, 85, 86],
          relatedDecisionIds: ["DEC-001", "DEC-002"],
        }),
      ],
      pullRequests: prs([84, 85, 86]),
      decisions: [decision(), decision({ decisionId: "DEC-002", title: "Ships are plugins" })],
    });

    const ids = new Set(shown(s).map((x) => x.id));
    expect(ids.size).toBe(shown(s).length);
  });
});

// ---------------------------------------------------------------------------

function harness() {
  const db = openDatabase({ location: ":memory:" });
  const store = new CompanionStore(db);
  const ledger = new SqliteEventLedger(db);
  store.upsertProject({ ...PARTY_GAMES, displayName: "Party Games" });
  return { db, store, ledger };
}

async function seededApp() {
  const h = harness();
  await durableSync({
    store: h.store,
    ledger: h.ledger,
    github: livePartyGamesPort(),
    project: h.store.getProject(PARTY_GAMES.id)!,
    ownerLogin: OWNER,
    now: NOW,
  });
  return { ...h, app: new CompanionApp({ store: h.store, ledger: h.ledger, ownerLogin: OWNER, clock: () => NOW }) };
}

/**
 * The lifecycle cases need a real suggestion to act on.
 *
 * Asserted rather than skipped-around: if the live fixtures stop carrying anything episode-worthy
 * these tests must fail loudly, not quietly certify a lifecycle they never exercised.
 */
function expectSuggestions(app: CompanionApp) {
  const suggestions = app.podcastSuggestions();
  expect(suggestions.length).toBeGreaterThan(0);
  return suggestions;
}

describe("the owner deciding", () => {
  it("a dismissed topic does not come back", async () => {
    const { app } = await seededApp();
    const before = expectSuggestions(app);

    expect(app.decideSuggestion(before[0]!.id, "DISMISSED")).toBeDefined();
    expect(app.podcastSuggestions().map((s) => s.id)).not.toContain(before[0]!.id);
  });

  it("a saved topic leaves the list but keeps the proposal as it stood", async () => {
    const { app } = await seededApp();
    const before = expectSuggestions(app);

    const saved = app.decideSuggestion(before[0]!.id, "SAVED")!;
    expect(saved.title).toBe(before[0]!.title);
    expect(saved.whyNow).toBe(before[0]!.whyNow);
    expect(saved.refs).toEqual(before[0]!.refs);
    expect(app.podcastSuggestions().map((s) => s.id)).not.toContain(before[0]!.id);
  });

  it("putting a dismissal back restores the suggestion", async () => {
    const { app } = await seededApp();
    const before = expectSuggestions(app);

    app.decideSuggestion(before[0]!.id, "DISMISSED");
    expect(app.undecideSuggestion(before[0]!.id)).toBe(true);
    expect(app.podcastSuggestions().map((s) => s.id)).toContain(before[0]!.id);
  });

  it("generates a script only from an approved topic, and never un-makes one", async () => {
    const { app } = await seededApp();
    const before = expectSuggestions(app);

    const script = app.createPodcastFromSuggestion(before[0]!.id)!;
    expect(script.kind).toBe("DEEP_DIVE");
    // The episode is about what was approved, phrased as it was approved.
    expect(script.title).toBe(before[0]!.title);

    // An episode that exists cannot be withdrawn, and a later save must not overwrite the record.
    expect(app.undecideSuggestion(before[0]!.id)).toBe(false);
    expect(app.decideSuggestion(before[0]!.id, "SAVED")!.decision).toBe("EPISODE_CREATED");
  });

  it("refuses to generate for an id nobody is suggesting", async () => {
    const { app } = await seededApp();
    expect(app.createPodcastFromSuggestion("sug_not_a_real_suggestion")).toBeUndefined();
  });
});
