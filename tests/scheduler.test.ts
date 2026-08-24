/**
 * Background sync.
 *
 * One property matters above the mechanics: a scheduled sync must never advance the read
 * cursor. If it did, the owner could be away for a week and come back to a briefing that had
 * already consumed itself.
 */

import { describe, expect, it, vi } from "vitest";

import { startScheduler } from "../src/sync/scheduler.ts";
import { openDatabase } from "../src/store/database.ts";
import { CompanionStore } from "../src/store/store.ts";
import { SqliteEventLedger } from "../src/ledger/sqlite-ledger.ts";
import { CompanionApp } from "../src/app/companion-app.ts";
import { durableSync } from "../src/sync/durable-sync.ts";
import { livePartyGamesPort, PARTY_GAMES } from "./live-port.ts";
import type { SyncAllResult } from "../src/sync/durable-sync.ts";

const EMPTY: SyncAllResult = { results: [], sequence: 0 };

describe("the scheduler", () => {
  it("does not run when the interval is zero or nonsense", () => {
    for (const intervalMinutes of [0, -5, Number.NaN]) {
      const sync = vi.fn(async () => EMPTY);
      expect(startScheduler({ intervalMinutes, sync }).running).toBe(false);
      expect(sync).not.toHaveBeenCalled();
    }
  });

  it("syncs on the interval until stopped", async () => {
    vi.useFakeTimers();
    try {
      const sync = vi.fn(async () => EMPTY);
      const scheduler = startScheduler({ intervalMinutes: 20, sync });

      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(sync).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(40 * 60_000);
      expect(sync).toHaveBeenCalledTimes(3);

      scheduler.stop();
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(sync).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start a second cycle while one is still running", async () => {
    vi.useFakeTimers();
    try {
      let release: (() => void) | undefined;
      const sync = vi.fn(
        () => new Promise<SyncAllResult>((resolve) => {
          release = () => resolve(EMPTY);
        }),
      );
      startScheduler({ intervalMinutes: 1, sync });

      // A cycle slower than the interval must not be joined by the next tick: two syncs writing
      // at once would contend for the same rows and gain nothing.
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(sync).toHaveBeenCalledTimes(1);

      release!();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sync).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("survives a failing cycle and keeps going", async () => {
    vi.useFakeTimers();
    try {
      const onError = vi.fn();
      const sync = vi
        .fn<() => Promise<SyncAllResult>>()
        .mockRejectedValueOnce(new Error("network down"))
        .mockResolvedValue(EMPTY);

      startScheduler({ intervalMinutes: 1, sync, onError });

      await vi.advanceTimersByTimeAsync(60_000);
      expect(onError).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(sync).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("background sync and the read cursor", () => {
  it("never advances the cursor, however many times it runs", async () => {
    const db = openDatabase({ location: ":memory:" });
    const store = new CompanionStore(db);
    const ledger = new SqliteEventLedger(db);
    store.upsertProject({ ...PARTY_GAMES, displayName: "Party Games" });

    const clock = { now: new Date("2026-08-24T12:00:00Z") };
    const app = new CompanionApp({ store, ledger, ownerLogin: "50thycal", clock: () => clock.now });

    const sync = () =>
      durableSync({
        store,
        ledger,
        github: livePartyGamesPort(),
        project: store.getProject(PARTY_GAMES.id)!,
        ownerLogin: "50thycal",
        now: clock.now,
      });

    await sync();
    const briefing = app.since();
    app.markChecked(briefing.toSequence, briefing.generatedAt);
    const marked = app.readCursor()!;

    // Several background cycles, exactly as the scheduler would drive them.
    for (const minutes of [20, 40, 60]) {
      clock.now = new Date(clock.now.getTime() + minutes * 60_000);
      await sync();
    }

    expect(app.readCursor()).toEqual(marked);
    db.close();
  });
});
