/**
 * Persistence, idempotency, and surviving a restart.
 *
 * The property under test is the one the product rests on: the owner closes the application,
 * comes back, and asks what changed — without a week of history announcing itself as new.
 */

import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/store/database.ts";
import { CompanionStore } from "../src/store/store.ts";
import { SqliteEventLedger } from "../src/ledger/sqlite-ledger.ts";
import { durableSync, syncAll } from "../src/sync/durable-sync.ts";
import { applyConfig, parseConfig, projectIdFor, ConfigError } from "../src/config/followed.ts";
import { livePartyGamesPort, PARTY_GAMES } from "./live-port.ts";
import type { AttentionItem } from "../src/domain/attention.ts";
import type { GitHubPullRequestObservation } from "../src/ingest/github/types.ts";

const NOW = new Date("2026-08-24T12:00:00Z");
const LATER = new Date("2026-08-24T13:00:00Z");

/** A fresh database, plus a way to "restart" onto the same file. */
function harness(location = ":memory:") {
  const db = openDatabase({ location });
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
    ownerLogin: "50thycal",
    now,
  });

describe("event idempotency", () => {
  it("appends nothing on a repeated sync of unchanged data", async () => {
    const h = harness();
    const first = await sync(h);
    expect(first.appended.length).toBeGreaterThan(0);

    const second = await sync(h, {}, LATER);
    expect(second.appended).toHaveLength(0);
    expect(h.ledger.size()).toBe(first.appended.length);
  });

  it("appends nothing even when the whole history is re-observed", async () => {
    const h = harness();
    const first = await sync(h);

    // The per-repository cursor normally means unchanged pull requests are never re-fetched, so
    // a quiet second sync produces no drafts to deduplicate. Clearing it forces the full
    // re-read that a cursor reset, a schema change, or a backfill would cause -- which is the
    // case fingerprint idempotency actually exists for.
    h.db.prepare("UPDATE projects SET last_synced_at = NULL").run();

    const replayed = await sync(h, {}, LATER);
    expect(replayed.appended).toHaveLength(0);
    expect(replayed.duplicates).toBeGreaterThan(0);
    expect(h.ledger.size()).toBe(first.appended.length);
  });

  it("keeps the ledger stable across many syncs", async () => {
    const h = harness();
    await sync(h);
    const size = h.ledger.size();
    for (let i = 0; i < 5; i += 1) await sync(h, {}, LATER);
    expect(h.ledger.size()).toBe(size);
  });

  it("appends only the genuinely new event when data changes", async () => {
    const h = harness();
    await sync(h);

    // A real merge moves `updated_at` too; without that the cursor would rightly skip the PR.
    const merge = (pr: GitHubPullRequestObservation): GitHubPullRequestObservation =>
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

    const second = await sync(h, { transform: merge, observedAt: "2026-08-24T13:00:00Z" }, LATER);
    expect(second.appended.map((e) => e.eventType)).toContain("PR_MERGED");
    expect(second.appended.filter((e) => e.eventType === "PR_OPENED")).toHaveLength(0);
  });
});

describe("restart", () => {
  it("does not reclassify old events as new after reopening the database", async () => {
    const file = `/tmp/companion-restart-${process.pid}.db`;
    const first = harness(file);
    const initial = await sync(first);
    const sequenceBefore = first.ledger.latestSequence();
    first.db.close();

    // A new process, the same file.
    const restarted = harness(file);
    expect(restarted.ledger.size()).toBe(initial.appended.length);
    expect(restarted.ledger.latestSequence()).toBe(sequenceBefore);

    const after = await sync(restarted, {}, LATER);
    expect(after.appended).toHaveLength(0);
    expect(restarted.ledger.latestSequence()).toBe(sequenceBefore);
    restarted.db.close();
  });

  it("rebuilds project state without syncing", async () => {
    const file = `/tmp/companion-state-${process.pid}.db`;
    const first = harness(file);
    const synced = await sync(first);
    first.db.close();

    const restarted = harness(file);
    const loaded = restarted.store.loadProjectState(PARTY_GAMES.id);

    expect(loaded.workstreams.map((w) => w.workstreamId)).toEqual(
      synced.state.workstreams.map((w) => w.workstreamId),
    );
    expect(loaded.pullRequests).toEqual(synced.state.pullRequests);
    expect(loaded.decisions.length).toBe(synced.state.decisions.length);
    restarted.db.close();
  });

  it("keeps the previous picture when a sync fails, marked stale", async () => {
    const h = harness();
    const good = await sync(h);
    expect(good.state.workstreams.length).toBeGreaterThan(0);

    const failed = await sync(h, { failWith: new Error("403 Forbidden") }, LATER);
    expect(failed.syncFailed).toContain("403");
    expect(failed.state.workstreams.map((w) => w.workstreamId)).toEqual(
      good.state.workstreams.map((w) => w.workstreamId),
    );

    const project = h.store.getProject(PARTY_GAMES.id)!;
    expect(project.staleSince).toBeDefined();
    expect(project.lastError).toContain("403");
  });

  it("clears the stale marker when syncing recovers", async () => {
    const h = harness();
    await sync(h, { failWith: new Error("boom") });
    expect(h.store.getProject(PARTY_GAMES.id)!.staleSince).toBeDefined();

    await sync(h, {}, LATER);
    const project = h.store.getProject(PARTY_GAMES.id)!;
    expect(project.staleSince).toBeUndefined();
    expect(project.lastError).toBeUndefined();
    expect(project.lastSyncedAt).toBe(LATER.toISOString());
  });
});

describe("the read cursor", () => {
  it("is absent until the owner marks something read", async () => {
    const h = harness();
    await sync(h);
    expect(h.store.getReadCursor("50thycal")).toBeUndefined();
  });

  it("is not advanced by syncing, only by an explicit mark", async () => {
    const h = harness();
    const first = await sync(h);
    expect(h.store.getReadCursor("50thycal")).toBeUndefined();

    h.store.markChecked("50thycal", first.sequence, NOW.toISOString());
    expect(h.store.getReadCursor("50thycal")!.lastSeq).toBe(first.sequence);

    // Another sync must not move it, however much it appends.
    await sync(h, { transform: (pr) => ({ ...pr, updatedAt: "2026-08-24T13:30:00Z" }) }, LATER);
    expect(h.store.getReadCursor("50thycal")!.lastSeq).toBe(first.sequence);
  });

  it("never moves backwards", async () => {
    const h = harness();
    const first = await sync(h);
    h.store.markChecked("50thycal", first.sequence, NOW.toISOString());
    h.store.markChecked("50thycal", 1, LATER.toISOString());
    expect(h.store.getReadCursor("50thycal")!.lastSeq).toBe(first.sequence);
  });

  it("returns only events learned after the cursor", async () => {
    const h = harness();
    const first = await sync(h);
    h.store.markChecked("50thycal", first.sequence, NOW.toISOString());

    expect(h.ledger.afterSequence(first.sequence)).toHaveLength(0);

    const second = await sync(
      h,
      {
        transform: (pr) =>
          pr.number === 142
            ? {
                ...pr,
                state: "closed",
                merged: true,
                mergedAt: "2026-08-24T12:30:00Z",
                closedAt: "2026-08-24T12:30:00Z",
                updatedAt: "2026-08-24T12:30:00Z",
              }
            : pr,
        observedAt: "2026-08-24T13:00:00Z",
      },
      LATER,
    );

    const fresh = h.ledger.afterSequence(first.sequence);
    expect(fresh.length).toBe(second.appended.length);
    expect(fresh.map((f) => f.event.eventType)).toContain("PR_MERGED");
  });

  it("orders by when the Companion learned an event, not when it happened", async () => {
    const h = harness();
    const first = await sync(h);
    h.store.markChecked("50thycal", first.sequence, NOW.toISOString());

    // A pull request opened in January, touched today and therefore observed for the first time
    // today. Its `occurred_at` is eight months old; to the owner it is new, and the cursor has
    // to say so.
    await sync(
      h,
      {
        transform: (pr) =>
          pr.number === 142
            ? { ...pr, number: 99, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-08-24T12:30:00Z" }
            : pr,
        observedAt: "2026-08-24T13:00:00Z",
      },
      LATER,
    );

    const fresh = h.ledger.afterSequence(first.sequence);
    const opened = fresh.find((f) => f.event.pullRequestNumber === 99 && f.event.eventType === "PR_OPENED");
    expect(opened).toBeDefined();
    expect(opened!.event.occurredAt).toBe("2026-01-01T00:00:00Z");

    // An `occurred_at` window would have missed it entirely: the event is months older than the
    // moment the owner last looked, and still brand new to them.
    expect(
      h.ledger.since(NOW.toISOString()).some((e) => e.pullRequestNumber === 99 && e.eventType === "PR_OPENED"),
    ).toBe(false);
  });
});

describe("attention lifecycle", () => {
  it("records an open item once and keeps its original first-seen time", async () => {
    const h = harness();
    const first = await sync(h);
    expect(first.openedAttention.length).toBeGreaterThan(0);

    const second = await sync(h, {}, LATER);
    expect(second.openedAttention).toHaveLength(0);

    const open = h.store.openAttention(PARTY_GAMES.id);
    expect(open.length).toBe(first.openedAttention.length);
    expect(open[0]!.firstSeenAt).toBe(NOW.toISOString());
    expect(open[0]!.lastSeenAt).toBe(LATER.toISOString());
  });

  it("marks an item resolved when it stops being true, rather than deleting it", async () => {
    const h = harness();
    const first = await sync(h);
    const decisionItem = first.openedAttention.find((a) => a.reasonCode === "OWNER_DECISION_REQUIRED")!;
    expect(decisionItem).toBeDefined();

    // The owner answers the decisions: the workstream file no longer lists any.
    const answered = livePartyGamesPort();
    const withoutDecisions = {
      ...answered,
      readFile: async (repo: string, path: string) => {
        const file = await answered.readFile(repo, path);
        if (!file || !path.includes("WS-001")) return file;
        return { ...file, content: file.content.replace(/^## Open Decisions[\s\S]*$/m, "## Open Decisions\n\nNone.\n") };
      },
    };

    const second = await durableSync({
      store: h.store,
      ledger: h.ledger,
      github: withoutDecisions,
      project: h.store.getProject(PARTY_GAMES.id)!,
      ownerLogin: "50thycal",
      now: LATER,
    });

    expect(second.resolvedAttention.map((a) => a.id)).toContain(decisionItem.id);
    expect(h.store.openAttention(PARTY_GAMES.id).map((a) => a.id)).not.toContain(decisionItem.id);
    expect(h.store.attentionResolvedAfter().map((a) => a.id)).toContain(decisionItem.id);
  });

  it("tracks only items that need the owner, not the engine's suppressions", async () => {
    const h = harness();
    const first = await sync(h);
    const suppressed = first.openedAttention.filter((a) => a.severity === "NONE");
    expect(suppressed).toHaveLength(0);
    expect(h.store.openAttention().every((a) => a.severity !== "NONE")).toBe(true);
  });
});

describe("attention dismissal", () => {
  // "I've seen this" is an owner action, recorded as its own fact — never the deterministic
  // engine's `clearedAt`, which means "this stopped being true." Confusing the two would let a
  // dismissal read back later as resolution, which is exactly the kind of quiet rewrite this
  // application exists to refuse to do anywhere else.
  const draft = (overrides: Partial<AttentionItem> = {}): AttentionItem => ({
    id: "att_test",
    projectId: PARTY_GAMES.id,
    entityType: "WORKSTREAM",
    entityId: "WS-001",
    severity: "MEDIUM",
    reasonCode: "WORKSTREAM_STALE",
    reasonText: "WS-001 has not moved",
    recommendedAction: "Resume it or pause it",
    evidence: [],
    createdAt: "2026-08-24T12:00:00Z",
    ...overrides,
  });

  function fresh() {
    const db = openDatabase({ location: ":memory:" });
    const store = new CompanionStore(db);
    return store;
  }

  it("removes a dismissed item from the open list without touching clearedAt", () => {
    const store = fresh();
    store.reconcileAttention(PARTY_GAMES.id, [draft()], NOW.toISOString(), 1);

    const [open] = store.openAttention(PARTY_GAMES.id);
    expect(open).toBeDefined();

    const dismissed = store.dismissAttention(open!.id, LATER.toISOString());
    expect(dismissed?.dismissedAt).toBe(LATER.toISOString());
    expect(dismissed?.clearedAt).toBeUndefined();

    expect(store.openAttention(PARTY_GAMES.id)).toHaveLength(0);
    expect(store.dismissedAttention(PARTY_GAMES.id).map((a) => a.id)).toEqual([open!.id]);
  });

  it("stays dismissed across a poll where the situation is unchanged", () => {
    const store = fresh();
    store.reconcileAttention(PARTY_GAMES.id, [draft()], NOW.toISOString(), 1);
    const [open] = store.openAttention(PARTY_GAMES.id);
    store.dismissAttention(open!.id, LATER.toISOString());

    // The same rule fires again next cycle, same severity, same wording.
    store.reconcileAttention(PARTY_GAMES.id, [draft()], "2026-08-24T14:00:00Z", 2);

    expect(store.openAttention(PARTY_GAMES.id)).toHaveLength(0);
    expect(store.dismissedAttention(PARTY_GAMES.id)).toHaveLength(1);
  });

  it("resurfaces a dismissed item when it gets worse", () => {
    const store = fresh();
    store.reconcileAttention(PARTY_GAMES.id, [draft({ severity: "MEDIUM" })], NOW.toISOString(), 1);
    const [open] = store.openAttention(PARTY_GAMES.id);
    store.dismissAttention(open!.id, LATER.toISOString());

    // Same id, now HIGH — materially new information the owner was not actually told.
    store.reconcileAttention(
      PARTY_GAMES.id,
      [draft({ severity: "HIGH", reasonText: "WS-001 is now blocked on you" })],
      "2026-08-24T14:00:00Z",
      2,
    );

    const [reopened] = store.openAttention(PARTY_GAMES.id);
    expect(reopened?.id).toBe(open!.id);
    expect(reopened?.severity).toBe("HIGH");
    expect(reopened?.dismissedAt).toBeUndefined();
    expect(store.dismissedAttention(PARTY_GAMES.id)).toHaveLength(0);
  });

  it("does not resurface a dismissed item that only got less severe", () => {
    const store = fresh();
    store.reconcileAttention(PARTY_GAMES.id, [draft({ severity: "HIGH" })], NOW.toISOString(), 1);
    const [open] = store.openAttention(PARTY_GAMES.id);
    store.dismissAttention(open!.id, LATER.toISOString());

    store.reconcileAttention(PARTY_GAMES.id, [draft({ severity: "MEDIUM" })], "2026-08-24T14:00:00Z", 2);

    expect(store.openAttention(PARTY_GAMES.id)).toHaveLength(0);
    expect(store.dismissedAttention(PARTY_GAMES.id)[0]!.severity).toBe("MEDIUM");
  });

  it("starts undismissed when a resolved item recurs as a fresh occurrence", () => {
    const store = fresh();
    store.reconcileAttention(PARTY_GAMES.id, [draft()], NOW.toISOString(), 1);
    const [open] = store.openAttention(PARTY_GAMES.id);
    store.dismissAttention(open!.id, LATER.toISOString());

    // The rule stops matching: resolved.
    store.reconcileAttention(PARTY_GAMES.id, [], "2026-08-24T14:00:00Z", 2);
    expect(store.openAttention(PARTY_GAMES.id)).toHaveLength(0);
    expect(store.dismissedAttention(PARTY_GAMES.id)).toHaveLength(0);

    // The same situation happens again later. A fresh occurrence, not a continuation of the
    // dismissed one — the owner has not seen this instance of it.
    store.reconcileAttention(PARTY_GAMES.id, [draft()], "2026-08-25T09:00:00Z", 3);
    const reopened = store.openAttention(PARTY_GAMES.id);
    expect(reopened).toHaveLength(1);
    expect(reopened[0]!.dismissedAt).toBeUndefined();
    expect(reopened[0]!.firstSeenAt).toBe("2026-08-25T09:00:00Z");
  });

  it("can be reversed", () => {
    const store = fresh();
    store.reconcileAttention(PARTY_GAMES.id, [draft()], NOW.toISOString(), 1);
    const [open] = store.openAttention(PARTY_GAMES.id);
    store.dismissAttention(open!.id, LATER.toISOString());
    expect(store.openAttention(PARTY_GAMES.id)).toHaveLength(0);

    const restored = store.undismissAttention(open!.id);
    expect(restored?.dismissedAt).toBeUndefined();
    expect(store.openAttention(PARTY_GAMES.id)).toHaveLength(1);
  });

  it("does nothing to an item that is already resolved", () => {
    const store = fresh();
    store.reconcileAttention(PARTY_GAMES.id, [draft()], NOW.toISOString(), 1);
    const [open] = store.openAttention(PARTY_GAMES.id);
    store.reconcileAttention(PARTY_GAMES.id, [], LATER.toISOString(), 2);

    const result = store.dismissAttention(open!.id, "2026-08-24T15:00:00Z");
    expect(result?.dismissedAt).toBeUndefined();
    expect(result?.clearedAt).toBeDefined();
  });
});

describe("followed repositories", () => {
  it("seeds both repositories from configuration, without code changes", () => {
    const db = openDatabase({ location: ":memory:" });
    const store = new CompanionStore(db);

    const config = parseConfig({
      ownerLogin: "50thycal",
      projects: [
        { repository: "50thycal/party-games", displayName: "Party Games" },
        { repository: "50thycal/build-os", paths: { decisions: "DECISIONS.md" } },
      ],
    });

    const projects = applyConfig(store, config, NOW);
    expect(projects.map((p) => p.repositoryFullName)).toEqual([
      "50thycal/build-os",
      "50thycal/party-games",
    ]);
    expect(store.getProject(projectIdFor("50thycal/build-os"))!.paths.decisions).toBe("DECISIONS.md");
  });

  it("adds a third repository by configuration alone", () => {
    const db = openDatabase({ location: ":memory:" });
    const store = new CompanionStore(db);

    applyConfig(store, parseConfig({ ownerLogin: "50thycal", projects: [{ repository: "50thycal/build-os" }] }), NOW);
    const grown = applyConfig(
      store,
      parseConfig({
        ownerLogin: "50thycal",
        projects: [{ repository: "50thycal/build-os" }, { repository: "50thycal/some-new-thing" }],
      }),
      NOW,
    );

    expect(grown).toHaveLength(2);
    expect(grown.map((p) => p.repositoryFullName)).toContain("50thycal/some-new-thing");
  });

  it("does not reset sync progress when the config is re-read", async () => {
    const h = harness();
    await sync(h);
    const before = h.store.getProject(PARTY_GAMES.id)!.lastSyncedAt;
    expect(before).toBeDefined();

    applyConfig(
      h.store,
      parseConfig({ ownerLogin: "50thycal", projects: [{ repository: "50thycal/party-games" }] }),
      LATER,
    );
    expect(h.store.getProject(PARTY_GAMES.id)!.lastSyncedAt).toBe(before);
  });

  it("disables a repository dropped from config instead of deleting its history", async () => {
    const h = harness();
    await sync(h);
    const events = h.ledger.size();

    applyConfig(h.store, parseConfig({ ownerLogin: "50thycal", projects: [] }), LATER);

    expect(h.store.listProjects()).toHaveLength(0);
    expect(h.store.listProjects({ includeDisabled: true })).toHaveLength(1);
    expect(h.ledger.size()).toBe(events);
  });

  it("rejects a config that would silently do the wrong thing", () => {
    expect(() => parseConfig({ projects: [] })).toThrow(ConfigError);
    expect(() => parseConfig({ ownerLogin: "x", projects: [{ repository: "not-a-repo" }] })).toThrow(ConfigError);
    expect(() =>
      parseConfig({ ownerLogin: "x", projects: [{ repository: "a/b" }, { repository: "a/b" }] }),
    ).toThrow(/more than once/);
  });
});

describe("syncing every followed project", () => {
  it("keeps going when one project fails", async () => {
    const db = openDatabase({ location: ":memory:" });
    const store = new CompanionStore(db);
    const ledger = new SqliteEventLedger(db);
    applyConfig(
      store,
      parseConfig({
        ownerLogin: "50thycal",
        projects: [{ repository: "50thycal/party-games" }, { repository: "50thycal/build-os" }],
      }),
      NOW,
    );

    const { results } = await syncAll({
      store,
      ledger,
      ownerLogin: "50thycal",
      now: NOW,
      github: (project) =>
        project.repositoryFullName === "50thycal/build-os"
          ? livePartyGamesPort({ failWith: new Error("no access") })
          : livePartyGamesPort(),
    });

    expect(results).toHaveLength(2);
    expect(results.find((r) => r.projectId === projectIdFor("50thycal/build-os"))!.syncFailed).toBeDefined();
    expect(results.find((r) => r.projectId === projectIdFor("50thycal/party-games"))!.syncFailed).toBeUndefined();
  });
});
