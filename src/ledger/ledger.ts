/**
 * The append-only event ledger.
 *
 * Append-only is not a storage preference, it is the reason the product can answer "what
 * changed since I last checked". State projections are rebuilt from here; nothing edits an
 * event after it lands.
 */

import type { CompanionEvent, EventDraft } from "../domain/events.ts";
import { DEFAULT_IMPORTANCE } from "../domain/events.ts";
import { eventIdFromFingerprint, fingerprint } from "./fingerprint.ts";

export interface AppendResult {
  /** Events that were genuinely new. */
  appended: CompanionEvent[];
  /** Drafts whose fingerprint was already present. Counted, not stored. */
  duplicates: number;
}

export interface EventLedger {
  append(drafts: EventDraft[], now?: Date): AppendResult;
  /** Chronological by `occurredAt`, with ingestion order as the tie-break. */
  all(): CompanionEvent[];
  forProject(projectId: string): CompanionEvent[];
  since(isoTimestamp: string): CompanionEvent[];
  has(sourceFingerprint: string): boolean;
  size(): number;
}

/** Turn a draft into an event. Exported so normalizers can be tested without a ledger. */
export function materialize(draft: EventDraft, now: Date): CompanionEvent {
  const fp = fingerprint({
    projectId: draft.projectId,
    eventType: draft.eventType,
    sourceType: draft.source.sourceType,
    sourceId: draft.source.sourceId,
    parts: draft.fingerprintParts,
  });

  const { fingerprintParts: _ignored, importance, ...rest } = draft;

  return {
    ...rest,
    id: eventIdFromFingerprint(fp),
    ingestedAt: now.toISOString(),
    importance: importance ?? DEFAULT_IMPORTANCE[draft.eventType],
    sourceFingerprint: fp,
  };
}

/**
 * In-memory implementation.
 *
 * The interface above is the contract a Postgres-backed ledger will implement; keeping the
 * projection and attention layers behind it means the persistence choice can be deferred
 * without leaving a rewrite behind.
 */
export class InMemoryEventLedger implements EventLedger {
  readonly #byFingerprint = new Map<string, CompanionEvent>();
  #sequence = 0;
  readonly #order = new Map<string, number>();

  append(drafts: EventDraft[], now: Date = new Date()): AppendResult {
    const appended: CompanionEvent[] = [];
    let duplicates = 0;

    for (const draft of drafts) {
      const event = materialize(draft, now);
      if (this.#byFingerprint.has(event.sourceFingerprint)) {
        duplicates += 1;
        continue;
      }
      this.#byFingerprint.set(event.sourceFingerprint, event);
      this.#order.set(event.sourceFingerprint, this.#sequence++);
      appended.push(event);
    }

    return { appended, duplicates };
  }

  all(): CompanionEvent[] {
    return [...this.#byFingerprint.values()].sort((a, b) => {
      const byTime = a.occurredAt.localeCompare(b.occurredAt);
      if (byTime !== 0) return byTime;
      return (
        (this.#order.get(a.sourceFingerprint) ?? 0) - (this.#order.get(b.sourceFingerprint) ?? 0)
      );
    });
  }

  forProject(projectId: string): CompanionEvent[] {
    return this.all().filter((e) => e.projectId === projectId);
  }

  since(isoTimestamp: string): CompanionEvent[] {
    return this.all().filter((e) => e.occurredAt > isoTimestamp);
  }

  has(sourceFingerprint: string): boolean {
    return this.#byFingerprint.has(sourceFingerprint);
  }

  size(): number {
    return this.#byFingerprint.size;
  }
}
