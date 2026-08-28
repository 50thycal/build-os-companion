/**
 * The catch-up briefing: what changed since the owner last checked, and the fact pack over it.
 *
 * The properties that matter are about trust. The cursor moves only when the owner says so;
 * nothing already read comes back; nothing is asserted that cannot be traced to a normalized
 * entity or event.
 */

import { describe, expect, it } from "vitest";
import type { GitHubPort } from "../src/ingest/github/client.ts";

import { openDatabase } from "../src/store/database.ts";
import { CompanionStore } from "../src/store/store.ts";
import { SqliteEventLedger } from "../src/ledger/sqlite-ledger.ts";
import { durableSync } from "../src/sync/durable-sync.ts";
import { buildSinceLastChecked } from "../src/briefing/since.ts";
import { buildFactPack, FACT_SECTIONS } from "../src/briefing/fact-pack.ts";
import { renderFactPack } from "../src/briefing/render.ts";
import { livePartyGamesPort, PARTY_GAMES } from "./live-port.ts";
import type { GitHubPullRequestObservation } from "../src/ingest/github/types.ts";

const NOW = new Date("2026-08-24T12:00:00Z");
const LATER = new Date("2026-08-24T13:00:00Z");
const OWNER = "50thycal";

function harness() {
  const db = openDatabase({ location: ":memory:" });
  const store = new CompanionStore(db);
  const ledger = new SqliteEventLedger(db);
  store.upsertProject({ ...PARTY_GAMES, displayName: "Party Games" });
  return { db, store, ledger };
}

const sync = (h: ReturnType<typeof harness>, opts: Parameters<typeof livePartyGamesPort>[0] = {}, now = NOW) =>
  durableSync({
    store: h.store,
    ledger: h.ledger,
    github: livePartyGamesPort(opts),
    project: h.store.getProject(PARTY_GAMES.id)!,
    ownerLogin: OWNER,
    now,
  });

const mergePr142 = (pr: GitHubPullRequestObservation): GitHubPullRequestObservation =>
  pr.number === 142
    ? {
        ...pr,
        state: "closed",
        merged: true,
        mergedAt: "2026-08-24T12:30:00Z",
        closedAt: "2026-08-24T12:30:00Z",
        updatedAt: "2026-08-24T12:30:00Z",
      }
    : pr;

const since = (h: ReturnType<typeof harness>, now = NOW) =>
  buildSinceLastChecked({ store: h.store, ledger: h.ledger, ownerUserId: OWNER, now });

const pack = (h: ReturnType<typeof harness>, now = NOW) =>
  buildFactPack({ store: h.store, ledger: h.ledger, ownerUserId: OWNER, now });

/**
 * The live Party Games artifacts with everything the attention engine could legitimately raise
 * already dealt with, so a test about an owner who owes nothing is testing exactly that.
 *
 * Two edits, not one. Answering WS-001's open decisions used to be the whole of it; it no longer
 * is, because WS-002 sits in REVIEW while the pull request that carried it has merged, and that
 * contradiction now reaches `Needs Me` instead of sitting below its threshold as a LOW
 * project-level note. Finalizing WS-002 is precisely what the owner would do about it.
 */
function nothingOutstanding(port: GitHubPort): GitHubPort["readFile"] {
  return async (repo, path) => {
    const file = await port.readFile(repo, path);
    if (!file) return file;
    if (path.includes("WS-001")) {
      return { ...file, content: file.content.replace(/^## Open Decisions[\s\S]*$/m, "## Open Decisions\n\nNone.\n") };
    }
    if (path.includes("WS-002")) {
      return {
        ...file,
        content: file.content
          .replace(/^\*\*Phase:\*\* REVIEW/m, "**Phase:** COMPLETE")
          .replace(/^\*\*Status:\*\* Active/m, "**Status:** Complete"),
      };
    }
    return file;
  };
}

describe("since I last checked", () => {
  it("calls the first look a first look rather than news", async () => {
    const h = harness();
    await sync(h);
    const result = since(h);

    expect(result.isFirstLook).toBe(true);
    expect(result.cursor).toBeUndefined();
    expect(result.fromSequence).toBe(0);
  });

  it("is empty once the owner has marked it read and nothing has happened", async () => {
    const h = harness();
    const first = await sync(h);
    h.store.markChecked(OWNER, first.sequence, NOW.toISOString());

    const result = since(h, LATER);
    expect(result.quiet).toBe(true);
    expect(result.eventCount).toBe(0);
    expect(result.groups).toHaveLength(0);
    expect(result.isFirstLook).toBe(false);
  });

  it("does not show an event twice across two briefings", async () => {
    const h = harness();
    const first = await sync(h);
    const before = since(h);
    const seen = new Set(before.groups.flatMap((g) => g.entries.flatMap((e) => e.eventIds)));
    expect(seen.size).toBeGreaterThan(0);

    h.store.markChecked(OWNER, first.sequence, NOW.toISOString());
    await sync(h, { transform: mergePr142, observedAt: "2026-08-24T13:00:00Z" }, LATER);

    const after = since(h, LATER);
    const now = after.groups.flatMap((g) => g.entries.flatMap((e) => e.eventIds));
    expect(now.length).toBeGreaterThan(0);
    for (const id of now) expect(seen.has(id)).toBe(false);
  });

  it("groups by meaning rather than listing events in order", async () => {
    const h = harness();
    await sync(h);
    const result = since(h);

    // A merged PR is reported as finished, not as a pull-request event among others.
    const finished = result.groups.find((g) => g.category === "FINISHED")!;
    expect(finished).toBeDefined();
    expect(finished.entries.map((e) => e.entityId)).toContain("pr:141");

    // Every entity appears in exactly one section.
    const entities = result.groups.flatMap((g) => g.entries.map((e) => `${e.projectId}|${e.entityId}`));
    expect(new Set(entities).size).toBe(entities.length);
  });

  it("collapses several events about one entity into one entry", async () => {
    const h = harness();
    await sync(h);
    const result = since(h);

    const pr141 = result.groups.flatMap((g) => g.entries).find((e) => e.entityId === "pr:141")!;
    // Opened and merged both landed; the owner is told once, and can still expand to both.
    expect(pr141.eventIds.length).toBeGreaterThan(1);
  });

  it("separates work that needed nobody from work that needs the owner", async () => {
    const h = harness();
    await sync(h);
    const result = since(h);

    const needsYou = result.groups.find((g) => g.category === "NEEDS_YOU");
    const autonomous = result.groups.find((g) => g.category === "AUTONOMOUS");

    expect(needsYou?.entries.some((e) => e.entityId === "WS-001")).toBe(true);
    // The agent-authored PR moved without the owner and is reported as such.
    expect(autonomous?.entries.length ?? 0).toBeGreaterThan(0);
  });

  it("reports an attention item that opened with no event behind it", async () => {
    const h = harness();
    const first = await sync(h);
    h.store.markChecked(OWNER, first.sequence, NOW.toISOString());

    // Nothing happens in GitHub; enough time passes that the open PR goes stale.
    const muchLater = new Date("2026-09-01T12:00:00Z");
    await durableSync({
      store: h.store,
      ledger: h.ledger,
      github: livePartyGamesPort(),
      project: h.store.getProject(PARTY_GAMES.id)!,
      ownerLogin: OWNER,
      now: muchLater,
    });

    const result = buildSinceLastChecked({ store: h.store, ledger: h.ledger, ownerUserId: OWNER, now: muchLater });
    const stale = result.newAttention.find((a) => a.reasonCode === "PR_STALE");
    expect(stale).toBeDefined();

    // It has no events, so an event-derived briefing would have been silent about it.
    const entry = result.groups
      .find((g) => g.category === "NEEDS_YOU")!
      .entries.find((e) => e.entityId === stale!.entityId)!;
    expect(entry).toBeDefined();
    expect(entry.eventIds).toHaveLength(0);
  });

  it("reports an attention item that stopped being true", async () => {
    const h = harness();
    const first = await sync(h);
    h.store.markChecked(OWNER, first.sequence, NOW.toISOString());

    const port = livePartyGamesPort();
    const answered = { ...port, readFile: nothingOutstanding(port) };

    await durableSync({
      store: h.store,
      ledger: h.ledger,
      github: answered,
      project: h.store.getProject(PARTY_GAMES.id)!,
      ownerLogin: OWNER,
      now: LATER,
    });

    const result = since(h, LATER);
    expect(result.resolvedAttention.some((a) => a.reasonCode === "OWNER_DECISION_REQUIRED")).toBe(true);
  });
});

describe("the fact pack", () => {
  it("has every target section, present even when empty", async () => {
    const h = harness();
    await sync(h);
    const built = pack(h);

    expect(built.sections.map((s) => s.key)).toEqual([...FACT_SECTIONS]);
    for (const section of built.sections) {
      expect(section.title).not.toBe("");
      expect(section.emptyText).not.toBe("");
    }
  });

  it("grounds every fact in a normalized entity or event", async () => {
    const h = harness();
    await sync(h);
    const built = pack(h);

    const facts = built.sections.flatMap((s) => s.facts);
    expect(facts.length).toBeGreaterThan(0);

    for (const fact of facts) {
      expect(fact.refs.length).toBeGreaterThan(0);
      expect(fact.text.trim()).not.toBe("");
      for (const ref of fact.refs) {
        expect(ref.id).not.toBe("");
        expect(ref.projectId).toBe(fact.projectId);
      }
    }
  });

  it("resolves every event reference to a real event in the ledger", async () => {
    const h = harness();
    await sync(h);
    const built = pack(h);

    const known = new Set(h.ledger.all().map((e) => e.id));
    const eventRefs = built.sections
      .flatMap((s) => s.facts)
      .flatMap((f) => f.refs)
      .filter((r) => r.kind === "EVENT");

    expect(eventRefs.length).toBeGreaterThan(0);
    for (const ref of eventRefs) expect(known.has(ref.id)).toBe(true);
  });

  it("puts the open decisions under what needs me, with the action to take", async () => {
    const h = harness();
    await sync(h);
    const needsMe = pack(h).sections.find((s) => s.key === "WHAT_NEEDS_ME")!;

    // The decisions, and the WS-002 record that still says REVIEW after its PR merged.
    expect(needsMe.facts).toHaveLength(2);
    expect(needsMe.facts[0]!.severity).toBe("HIGH");
    expect(needsMe.facts[0]!.action).toContain("Answer the open decisions");
    expect(needsMe.facts[0]!.refs.map((r) => r.kind)).toContain("ATTENTION");
    expect(needsMe.facts[1]!.text).toContain("WS-002 is still in REVIEW");
  });

  it("reports both active workstreams and what each is doing", async () => {
    const h = harness();
    await sync(h);
    const happening = pack(h).sections.find((s) => s.key === "WHAT_IS_HAPPENING")!;

    expect(happening.facts).toHaveLength(2);
    expect(happening.facts.map((f) => f.text).join(" ")).toContain("WS-001");
    expect(happening.facts.map((f) => f.text).join(" ")).toContain("WS-002");
    expect(happening.facts.every((f) => f.text.includes("review"))).toBe(true);
  });

  it("says nothing needs the owner when nothing does, rather than going quiet", async () => {
    const h = harness();
    const port = livePartyGamesPort();
    const answered = { ...port, readFile: nothingOutstanding(port) };

    await durableSync({
      store: h.store,
      ledger: h.ledger,
      github: answered,
      project: h.store.getProject(PARTY_GAMES.id)!,
      ownerLogin: OWNER,
      now: NOW,
    });

    const needsMe = pack(h).sections.find((s) => s.key === "WHAT_NEEDS_ME")!;
    expect(needsMe.facts).toHaveLength(0);
    expect(needsMe.emptyText).toContain("No rule in the attention engine matched");
  });

  it("surfaces a stale project rather than presenting its old state as current", async () => {
    const h = harness();
    await sync(h);
    await sync(h, { failWith: new Error("403 Forbidden") }, LATER);

    const built = pack(h, LATER);
    expect(built.projects[0]!.staleSince).toBeDefined();
    expect(renderFactPack(built)).toContain("Stale:");
  });
});

describe("rendering", () => {
  it("is deterministic: the same pack renders identically", async () => {
    const h = harness();
    await sync(h);
    const built = pack(h);
    expect(renderFactPack(built)).toBe(renderFactPack(built));
  });

  it("renders every section heading", async () => {
    const h = harness();
    await sync(h);
    const text = renderFactPack(pack(h));

    for (const section of pack(h).sections) expect(text).toContain(`## ${section.title}`);
  });

  it("can show the references behind each fact", async () => {
    const h = harness();
    await sync(h);
    const text = renderFactPack(pack(h), { includeRefs: true });
    expect(text).toContain("refs: ");
    expect(text).toMatch(/ATTENTION\/att_/);
  });
});
