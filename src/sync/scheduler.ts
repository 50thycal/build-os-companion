/**
 * Periodic background sync.
 *
 * In-process rather than a separate cron service, because a volume attaches to exactly one
 * service on Railway and every comparable host — a second container running the sync CLI could
 * not open the same database. Keeping it here means one service, one volume, no coordination.
 *
 * It never advances the read cursor. That is the property that makes background syncing safe at
 * all: the owner can be away for a week, come back, and still be shown everything that happened
 * since they last pressed the button rather than since the last poll.
 */

import type { SyncAllResult } from "./durable-sync.ts";

export interface SchedulerOptions {
  /** How often to sync. Zero or less disables it entirely. */
  intervalMinutes: number;
  sync: () => Promise<SyncAllResult>;
  onResult?: (result: SyncAllResult) => void;
  onError?: (error: unknown) => void;
}

export interface Scheduler {
  stop(): void;
  readonly running: boolean;
}

export function startScheduler(options: SchedulerOptions): Scheduler {
  if (!Number.isFinite(options.intervalMinutes) || options.intervalMinutes <= 0) {
    return { stop() {}, running: false };
  }

  // A slow sync must not overlap the next tick: GitHub polling plus artifact reads can outrun a
  // short interval, and two cycles writing at once would fight over the same rows for no gain.
  let inFlight = false;

  const timer = setInterval(
    () => {
      if (inFlight) return;
      inFlight = true;
      options
        .sync()
        .then((result) => options.onResult?.(result))
        .catch((error: unknown) => options.onError?.(error))
        .finally(() => {
          inFlight = false;
        });
    },
    options.intervalMinutes * 60_000,
  );

  // Never hold the process open on its own account; the HTTP server decides the lifetime.
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
    },
    running: true,
  };
}
