/**
 * The whole sync path, end to end, over real party-games data.
 *
 * Normalize -> ledger -> projection -> attention -> feed, with the pull requests and the Build OS
 * artifacts the repository actually had on 2026-08-24. This is the test that would have caught
 * every Phase 2 regression at once: the unit tests all passed while the pipeline produced
 * truncated decisions and claimed a repository with no CI was healthy.
 */

import { describe, expect, it } from "vitest";

import { InMemoryEventLedger } from "../src/ledger/ledger.ts";
import { syncProject } from "../src/sync/sync-project.ts";
import { needsMe } from "../src/attention/engine.ts";
import { PARTY_GAMES, livePartyGamesPort } from "./live-port.ts";

const NOW = new Date("2026-08-24T12:00:00Z");

async function sync(overrides: Parameters<typeof livePartyGamesPort>[0] = {}, ledger = new InMemoryEventLedger()) {
  return {
    ledger,
    result: await syncProject({
      project: PARTY_GAMES,
      github: livePartyGamesPort(overrides),
      ledger,
      ownerLogin: "50thycal",
      now: NOW,
    }),
  };
}

describe("live sync over real party-games data", () => {
  it("reconstructs both workstreams from the real board and files", async () => {
    const { result } = await sync();
    const ids = result.state.workstreams.map((w) => w.workstreamId);

    expect(ids).toEqual(["WS-001", "WS-002"]);
    expect(result.state.workstreams.every((w) => w.phase === "REVIEW")).toBe(true);
    expect(result.state.workstreams.every((w) => w.status === "ACTIVE")).toBe(true);
  });

  it("links the real workstreams to the real pull requests, many-to-many", async () => {
    const { result } = await sync();
    const ws001 = result.state.workstreams.find((w) => w.workstreamId === "WS-001")!;

    expect(ws001.relatedPrNumbers).toEqual([137, 139]);

    const pr141 = result.state.pullRequests.find((p) => p.number === 141)!;
    expect(pr141.workstreamIds).toEqual(["WS-002"]);
  });

  it("classifies the merged PR as MERGED, not CLOSED", async () => {
    const { result } = await sync();
    const pr141 = result.state.pullRequests.find((p) => p.number === 141)!;
    const pr142 = result.state.pullRequests.find((p) => p.number === 142)!;

    expect(pr141.lifecycle).toBe("MERGED");
    expect(pr142.lifecycle).toBe("OPEN");
  });

  it("surfaces the eight open decisions as one owner-attention item, readable in full", async () => {
    const { result } = await sync();
    const decisions = needsMe(result.attention).filter((a) => a.reasonCode === "OWNER_DECISION_REQUIRED");

    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.entityId).toBe("WS-001");
    expect(decisions[0]!.reasonText).toContain("8 decisions");
    // The regression: the quoted question used to stop mid-clause at the file's line wrap.
    expect(decisions[0]!.reasonText).toMatch(/[.?!]$/);
    expect(decisions[0]!.reasonText).not.toMatch(/eat its$/);
  });

  it("never tells the owner a PR is healthy in a repository with no CI", async () => {
    const { result } = await sync();
    for (const item of result.attention) {
      expect(item.reasonText).not.toMatch(/healthy/i);
      expect(item.reasonText).not.toContain("none CI");
    }
  });

  it("does not raise CI or merge-conflict attention when nothing reported either", async () => {
    const { result } = await sync();
    const codes = new Set(needsMe(result.attention).map((a) => a.reasonCode));

    expect(codes.has("PR_CI_FAILED")).toBe(false);
    // `mergeable_state` is unknown for every real PR, so a conflict is not *claimed* either.
    expect(codes.has("MERGE_CONFLICT")).toBe(false);
  });

  it("builds feed cards for the real entities, each answering what changed and what is needed", async () => {
    const { result } = await sync();
    expect(result.cards.length).toBeGreaterThan(0);

    for (const card of result.cards) {
      expect(card.headline).not.toBe("");
      expect(card.needsYou).not.toBe("");
      expect(card.currentState).not.toBe("");
      expect(card.eventIds.length).toBeGreaterThan(0);
    }

    const pr141 = result.cards.find((c) => c.entityId === "pr:141")!;
    expect(pr141.whyItMatters).toContain("WS-002");
  });

  it("credits agent branches to an AGENT actor", async () => {
    const { result } = await sync();
    const agentEvents = result.appended.filter((e) => e.actor.type === "AGENT");

    expect(agentEvents.length).toBeGreaterThan(0);
    expect(agentEvents.every((e) => e.actor.name === "50thycal")).toBe(true);
  });
});

describe("repeated sync over unchanged live data", () => {
  it("appends nothing the second time", async () => {
    const ledger = new InMemoryEventLedger();
    const first = await sync({}, ledger);
    expect(first.result.appended.length).toBeGreaterThan(0);

    const second = await sync({}, ledger);
    expect(second.result.appended).toHaveLength(0);
    expect(second.result.duplicates).toBeGreaterThan(0);
    expect(ledger.size()).toBe(first.result.appended.length);
  });

  it("produces the same projection and the same attention on the second pass", async () => {
    const ledger = new InMemoryEventLedger();
    const first = await sync({}, ledger);
    const second = await sync({}, ledger);

    expect(second.result.state.pullRequests).toEqual(first.result.state.pullRequests);
    expect(second.result.attention.map((a) => a.id)).toEqual(first.result.attention.map((a) => a.id));
  });

  it("records a failed poll as an event instead of erasing state", async () => {
    const ledger = new InMemoryEventLedger();
    await sync({}, ledger);
    const failed = await sync({ failWith: new Error("network down") }, ledger);

    expect(failed.result.syncFailed).toContain("network down");
    expect(failed.result.appended.some((e) => e.eventType === "SYNC_FAILED")).toBe(true);
    // The previous picture survives.
    expect(failed.result.state.pullRequests.length).toBeGreaterThan(0);
  });
});
