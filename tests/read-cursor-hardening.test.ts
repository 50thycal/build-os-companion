/**
 * The read cursor cannot be consumed by a stale page or a bad sequence.
 *
 * Catch Up is a trust surface: the owner relies on it to have been told things exactly once. The
 * cursor has two dimensions — how far through the events they have read, and the moment their
 * briefing was true as of — and both have to be monotonic. `last_seq` was; `last_checked_at`
 * was not, and it is the one attention depends on.
 */

import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/store/database.ts";
import { CompanionStore } from "../src/store/store.ts";
import { SqliteEventLedger } from "../src/ledger/sqlite-ledger.ts";
import { CompanionApp } from "../src/app/companion-app.ts";
import { durableSync } from "../src/sync/durable-sync.ts";
import { livePartyGamesPort, PARTY_GAMES } from "./live-port.ts";

const OWNER = "50thycal";

function harness(clock: { now: Date }) {
  const db = openDatabase({ location: ":memory:" });
  const store = new CompanionStore(db);
  const ledger = new SqliteEventLedger(db);
  store.upsertProject({ ...PARTY_GAMES, displayName: "Party Games" });
  const app = new CompanionApp({ store, ledger, ownerLogin: OWNER, clock: () => clock.now });
  return { db, store, ledger, app, clock };
}

const sync = (h: ReturnType<typeof harness>, at: Date, opts: Parameters<typeof livePartyGamesPort>[0] = {}) =>
  durableSync({
    store: h.store,
    ledger: h.ledger,
    github: livePartyGamesPort(opts),
    project: h.store.getProject(PARTY_GAMES.id)!,
    ownerLogin: OWNER,
    now: at,
  });

describe("a stale briefing cannot consume newer attention", () => {
  it("keeps an item that appeared after the briefing being submitted was generated", async () => {
    const clock = { now: new Date("2026-08-24T10:00:00Z") };
    const h = harness(clock);
    await sync(h, clock.now);

    // 10:00 — the owner reads briefing A and marks it.
    const briefingA = h.app.since();
    h.app.markChecked(briefingA.toSequence, briefingA.generatedAt);

    // 10:05 — a pull request goes stale. New attention, no new event, so the sequence is
    // unchanged: this item exists only on the timestamp dimension.
    clock.now = new Date("2026-08-29T10:05:00Z");
    await sync(h, clock.now);
    const staleItem = h.store.openAttention().find((a) => a.reasonCode === "PR_STALE");
    expect(staleItem, "the scenario needs a no-event attention item").toBeDefined();
    expect(h.app.since().newAttention.map((a) => a.id)).toContain(staleItem!.id);

    // 10:10 — an older browser tab, still showing briefing A, posts it again.
    clock.now = new Date("2026-08-29T10:10:00Z");
    h.app.markChecked(briefingA.toSequence, briefingA.generatedAt);

    // Briefing A never contained the stale item, so submitting it must not consume it.
    expect(h.app.since().newAttention.map((a) => a.id)).toContain(staleItem!.id);
  });

  it("never moves either dimension of the cursor backwards", async () => {
    const clock = { now: new Date("2026-08-24T10:00:00Z") };
    const h = harness(clock);
    await sync(h, clock.now);

    const fresh = h.app.since();
    h.app.markChecked(fresh.toSequence, fresh.generatedAt);
    const after = h.app.readCursor()!;

    // An older tab posts an older sequence and an older checkpoint.
    clock.now = new Date("2026-08-24T11:00:00Z");
    h.app.markChecked(1, "2026-08-01T00:00:00Z");

    const now = h.app.readCursor()!;
    expect(now.lastSeq).toBe(after.lastSeq);
    expect(now.lastCheckedAt).toBe(after.lastCheckedAt);
  });

  it("advances the timestamp when a later briefing carries the same event sequence", async () => {
    const clock = { now: new Date("2026-08-24T10:00:00Z") };
    const h = harness(clock);
    await sync(h, clock.now);

    const briefingA = h.app.since();
    h.app.markChecked(briefingA.toSequence, briefingA.generatedAt);

    // Time passes, a PR goes stale — attention changes, the ledger does not.
    clock.now = new Date("2026-08-29T10:05:00Z");
    await sync(h, clock.now);
    const staleItem = h.store.openAttention().find((a) => a.reasonCode === "PR_STALE")!;

    // The owner reads a *newer* briefing carrying the same toSequence and marks it.
    clock.now = new Date("2026-08-29T10:06:00Z");
    const briefingB = h.app.since();
    expect(briefingB.toSequence).toBe(briefingA.toSequence);
    h.app.markChecked(briefingB.toSequence, briefingB.generatedAt);

    // That one did contain the stale item, so it is consumed.
    expect(h.app.since().newAttention.map((a) => a.id)).not.toContain(staleItem.id);
  });
});

describe("a sequence beyond the ledger cannot suppress future events", () => {
  it("refuses a sequence higher than anything recorded", async () => {
    const clock = { now: new Date("2026-08-24T10:00:00Z") };
    const h = harness(clock);
    await sync(h, clock.now);

    const before = h.app.readCursor();
    expect(h.app.markChecked(999_999, clock.now.toISOString())).toBeUndefined();
    expect(h.app.readCursor()).toEqual(before);
  });

  it("still reports events that arrive after a rejected submission", async () => {
    const clock = { now: new Date("2026-08-24T10:00:00Z") };
    const h = harness(clock);
    await sync(h, clock.now);
    h.app.markChecked(999_999, clock.now.toISOString());

    clock.now = new Date("2026-08-24T13:00:00Z");
    const appended = await sync(h, clock.now, {
      observedAt: "2026-08-24T13:00:00Z",
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
    });
    expect(appended.appended.length).toBeGreaterThan(0);

    // A rejected submission must leave the ledger fully readable.
    const since = h.app.since();
    expect(since.eventCount).toBeGreaterThan(0);
    expect(since.groups.flatMap((g) => g.entries).some((e) => e.entityId === "pr:142")).toBe(true);
  });

  it("does not let a future checkpoint timestamp suppress attention that has not happened", async () => {
    const clock = { now: new Date("2026-08-24T10:00:00Z") };
    const h = harness(clock);
    await sync(h, clock.now);

    const briefing = h.app.since();
    h.app.markChecked(briefing.toSequence, "2099-01-01T00:00:00Z");

    // Clamped to the server's clock, never accepted as given.
    expect(h.app.readCursor()!.lastCheckedAt).toBe(clock.now.toISOString());

    clock.now = new Date("2026-08-29T10:05:00Z");
    await sync(h, clock.now);
    expect(h.app.since().newAttention.some((a) => a.reasonCode === "PR_STALE")).toBe(true);
  });
});

/**
 * End-to-end through the web path.
 *
 * The tests above call `markChecked` directly, which is why they all passed while the product
 * was still wrong: the storage layer was correct and the button that reaches it was disabled.
 * These drive `/briefing` and the real form POST, parsing the control and its hidden fields out
 * of the rendered HTML, so a briefing that cannot be acknowledged in the browser fails here.
 */
describe("acknowledging a briefing through the browser", () => {
  const OWNER_LOGIN = "50thycal";

  /** The mark-as-read control as actually rendered: its fields, and whether it is usable. */
  function readForm(html: string): { sequence: string; checkpointAt: string; enabled: boolean } {
    const form = /<form method="post" action="\/briefing\/checked"[\s\S]*?<\/form>/.exec(html)?.[0];
    if (!form) throw new Error("no mark-as-read form rendered");
    return {
      sequence: /name="sequence" value="([^"]*)"/.exec(form)?.[1] ?? "",
      checkpointAt: /name="checkpointAt" value="([^"]*)"/.exec(form)?.[1] ?? "",
      enabled: !/<button[^>]*\sdisabled/.test(form),
    };
  }

  async function serving<T>(app: CompanionApp, work: (base: string) => Promise<T>): Promise<T> {
    const { createCompanionServer } = await import("../src/web/server.ts");
    const server = createCompanionServer({ app });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      return await work(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("lets the owner acknowledge attention that arrived without an event", async () => {
    const clock = { now: new Date("2026-08-24T10:00:00Z") };
    const h = harness(clock);
    await sync(h, clock.now);

    await serving(h.app, async (base) => {
      // The owner reads and marks the first briefing, through the form.
      const first = readForm(await (await fetch(`${base}/briefing`)).text());
      expect(first.enabled).toBe(true);
      await fetch(`${base}/briefing/checked`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ sequence: first.sequence, checkpointAt: first.checkpointAt }),
        redirect: "manual",
      });

      const marked = h.app.readCursor()!;
      expect(marked.lastSeq).toBe(h.ledger.latestSequence());

      // Time passes and a pull request goes stale. Attention opens; no event is appended.
      clock.now = new Date("2026-08-29T10:05:00Z");
      await sync(h, clock.now);

      const staleItem = h.store.openAttention().find((a) => a.reasonCode === "PR_STALE");
      expect(staleItem, "the scenario needs a no-event attention item").toBeDefined();
      expect(h.ledger.latestSequence()).toBe(marked.lastSeq);

      // The briefing shows it, at an unchanged event sequence.
      const page = await (await fetch(`${base}/briefing`)).text();
      const since = h.app.since();
      expect(since.toSequence).toBe(since.fromSequence);
      expect(since.newAttention.map((a) => a.id)).toContain(staleItem!.id);
      expect(page).toContain(staleItem!.reasonText.slice(0, 40));

      // The regression: the only control that can acknowledge it must not be disabled.
      const second = readForm(page);
      expect(second.enabled).toBe(true);
      expect(second.sequence).toBe(String(since.toSequence));

      // Posting it advances the timestamp dimension and leaves the sequence alone.
      await fetch(`${base}/briefing/checked`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ sequence: second.sequence, checkpointAt: second.checkpointAt }),
        redirect: "manual",
      });

      const after = h.app.readCursor()!;
      expect(after.lastSeq).toBe(marked.lastSeq);
      expect(after.lastCheckedAt > marked.lastCheckedAt).toBe(true);

      // And it is not reported as new again.
      expect(h.app.since().newAttention.map((a) => a.id)).not.toContain(staleItem!.id);
    });
  });

  it("disables the control only when there is genuinely nothing to acknowledge", async () => {
    const clock = { now: new Date("2026-08-24T10:00:00Z") };
    const h = harness(clock);
    await sync(h, clock.now);

    await serving(h.app, async (base) => {
      const first = readForm(await (await fetch(`${base}/briefing`)).text());
      await fetch(`${base}/briefing/checked`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ sequence: first.sequence, checkpointAt: first.checkpointAt }),
        redirect: "manual",
      });

      // Nothing has happened since; the briefing is genuinely empty.
      clock.now = new Date("2026-08-24T10:30:00Z");
      const since = h.app.since();
      expect(since.quiet).toBe(true);
      expect(since.newAttention).toHaveLength(0);
      expect(since.resolvedAttention).toHaveLength(0);

      expect(readForm(await (await fetch(`${base}/briefing`)).text()).enabled).toBe(false);
    });
  });

  it("lets the owner acknowledge a resolution that arrived without an event", async () => {
    const clock = { now: new Date("2026-08-24T10:00:00Z") };
    const h = harness(clock);
    await sync(h, clock.now);
    const briefing = h.app.since();
    h.app.markChecked(briefing.toSequence, briefing.generatedAt);

    // The owner answers WS-001's decisions in the repository. The workstream file changes but
    // emits no event, so the resolution exists only on the timestamp dimension.
    const port = livePartyGamesPort();
    clock.now = new Date("2026-08-24T11:00:00Z");
    await durableSync({
      store: h.store,
      ledger: h.ledger,
      github: {
        ...port,
        readFile: async (repo: string, path: string) => {
          const file = await port.readFile(repo, path);
          if (!file || !path.includes("WS-001")) return file;
          return { ...file, content: file.content.replace(/^## Open Decisions[\s\S]*$/m, "## Open Decisions\n\nNone.\n") };
        },
      },
      project: h.store.getProject(PARTY_GAMES.id)!,
      ownerLogin: OWNER_LOGIN,
      now: clock.now,
    });

    const since = h.app.since();
    expect(since.resolvedAttention.length).toBeGreaterThan(0);
    // A resolution only becomes a group when its entity also had events, so this one does not.
    expect(since.quiet).toBe(true);
    expect(since.acknowledgeable).toBe(true);

    await serving(h.app, async (base) => {
      expect(readForm(await (await fetch(`${base}/briefing`)).text()).enabled).toBe(true);
    });
  });
});
