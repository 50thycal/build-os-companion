import { describe, expect, it } from "vitest";

import { InMemoryEventLedger } from "../src/ledger/ledger.ts";
import { normalizeGitHubObservation } from "../src/ingest/github/normalize.ts";
import { reconcileBuildOsState } from "../src/ingest/buildos/reconcile.ts";
import { normalizeWorkstreams } from "../src/ingest/buildos/normalize.ts";
import {
  buildProjectState,
  linkWorkstreamsToPullRequests,
  projectPullRequests,
} from "../src/projection/project.ts";
import { computeAttention } from "../src/attention/engine.ts";
import { buildFeed } from "../src/feed/cards.ts";
import { buildOsSnapshotInput, observation } from "./helpers.ts";
import type { PullRequestState, WorkstreamState } from "../src/domain/state.ts";

const PROJECT = "proj_cargo_ship";
const NOW = new Date("2026-08-23T18:00:00Z");

function ledgerWithBothCycles() {
  const ledger = new InMemoryEventLedger();
  ledger.append(normalizeGitHubObservation(observation(1), { projectId: PROJECT }));
  const previous = new Map(projectPullRequests(ledger.all()).map((p) => [p.number, p]));
  ledger.append(normalizeGitHubObservation(observation(2), { projectId: PROJECT, previous }));
  return ledger;
}

describe("workstream and pull-request linkage", () => {
  it("supports one workstream spanning several PRs", () => {
    const ws = {
      workstreamId: "WS-001",
      relatedPrNumbers: [84, 91],
    } as unknown as WorkstreamState;

    const prs = [
      { number: 84, workstreamIds: [] },
      { number: 91, workstreamIds: [] },
    ] as unknown as PullRequestState[];

    const linked = linkWorkstreamsToPullRequests([ws], prs);
    expect(linked.map((p) => p.workstreamIds)).toEqual([["WS-001"], ["WS-001"]]);
  });

  it("supports one PR serving several workstreams", () => {
    const workstreams = [
      { workstreamId: "WS-001", relatedPrNumbers: [84] },
      { workstreamId: "WS-002", relatedPrNumbers: [84] },
    ] as unknown as WorkstreamState[];

    const linked = linkWorkstreamsToPullRequests(workstreams, [
      { number: 84, workstreamIds: [] },
    ] as unknown as PullRequestState[]);

    expect(linked[0]!.workstreamIds).toEqual(["WS-001", "WS-002"]);
  });
});

describe("feed cards", () => {
  const ledger = ledgerWithBothCycles();
  const reconciled = reconcileBuildOsState(PROJECT, buildOsSnapshotInput());
  ledger.append(normalizeWorkstreams(reconciled.workstreams, { projectId: PROJECT }));
  const state = buildProjectState({
    projectId: PROJECT,
    events: ledger.all(),
    workstreams: reconciled.workstreams,
    integrityWarnings: reconciled.warnings,
    conflicts: reconciled.conflicts,
  });
  const attention = computeAttention({ state, ownerLogin: "50thycal", now: NOW });
  const cards = buildFeed({
    projectId: PROJECT,
    projectName: "50thycal/cargo-ship",
    state,
    events: ledger.all(),
    attention,
    now: NOW,
  });

  it("collapses many events about one entity into one card", () => {
    const pr84Cards = cards.filter((c) => c.entityId === "pr:84");
    expect(pr84Cards).toHaveLength(1);
    expect(pr84Cards[0]!.eventIds.length).toBeGreaterThan(1);
  });

  it("answers the five questions on every card", () => {
    for (const card of cards) {
      expect(card.headline.length).toBeGreaterThan(0);
      expect(card.whatChanged.length).toBeGreaterThan(0);
      expect(card.currentState.length).toBeGreaterThan(0);
      expect(card.needsYou.length).toBeGreaterThan(0);
    }
  });

  it("says `Nothing.` rather than staying silent when nothing is needed", () => {
    const quiet = cards.filter((c) => c.severity === "NONE");
    expect(quiet.length).toBeGreaterThan(0);
    expect(quiet.every((c) => c.needsYou === "Nothing.")).toBe(true);
  });

  it("puts what needs the owner above what is merely recent", () => {
    const needsOwnerIndex = cards.findIndex((c) => c.needsYou !== "Nothing.");
    const quietIndex = cards.findIndex((c) => c.needsYou === "Nothing.");
    expect(needsOwnerIndex).toBeLessThan(quietIndex);
  });

  it("links every card back to its canonical GitHub source", () => {
    const prCards = cards.filter((c) => c.entityType === "PULL_REQUEST");
    expect(prCards.length).toBeGreaterThan(0);
    expect(prCards.every((c) => c.sourceUrl?.startsWith("https://github.com/"))).toBe(true);
  });

  it("describes current state rather than repeating the headline", () => {
    const pr84 = cards.find((c) => c.entityId === "pr:84")!;
    expect(pr84.currentState).toContain("CI failed");
  });

  it("carries the workstream a PR belongs to into why it matters", () => {
    const pr84 = cards.find((c) => c.entityId === "pr:84")!;
    expect(pr84.whyItMatters).toContain("WS-001");
  });

  it("honours a since cursor for `what changed while I was away`", () => {
    const recent = buildFeed({
      projectId: PROJECT,
      projectName: "50thycal/cargo-ship",
      state,
      events: ledger.all(),
      attention,
      now: NOW,
      since: "2026-08-23T13:00:00Z",
    });
    expect(recent.length).toBeLessThan(cards.length);
  });
});
