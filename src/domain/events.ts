/**
 * The normalized event ledger's event model.
 *
 * An event is an owner-meaningful thing that happened. It is deliberately *not* a mirror of a
 * GitHub webhook: several webhook deliveries may produce one event, and some produce none.
 *
 * Events are append-only and immutable. Anything derived — attention, summaries, rankings — is
 * computed from them at read time and never frozen into them.
 */

import type { SourceRef } from "./provenance.ts";

export const EVENT_TYPES = [
  // Pull requests
  "PR_OPENED",
  "PR_UPDATED",
  "PR_READY_FOR_REVIEW",
  "PR_REVIEWED",
  "PR_CHANGES_REQUESTED",
  "PR_MERGED",
  "PR_CLOSED",
  // Continuous integration
  "CI_STARTED",
  "CI_PASSED",
  "CI_FAILED",
  // Issues
  "ISSUE_OPENED",
  "ISSUE_UPDATED",
  // Build OS durable state
  "WORKSTREAM_CREATED",
  "WORKSTREAM_PHASE_CHANGED",
  "WORKSTREAM_BLOCKED",
  "WORKSTREAM_UNBLOCKED",
  "WORKSTREAM_COMPLETED",
  "DECISION_ADDED",
  "PROJECT_MODEL_CHANGED",
  // Agent sessions
  "SESSION_STARTED",
  "SESSION_CHECKPOINTED",
  "SESSION_BLOCKED",
  "SESSION_COMPLETED",
  // Operational
  "SYNC_FAILED",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type ActorType = "HUMAN" | "AGENT" | "BOT" | "SYSTEM";

export interface Actor {
  type: ActorType;
  /** Display name: a GitHub login, an agent name, or `system`. */
  name: string;
}

/**
 * How significant this event is *as a change*, independent of whether it needs the owner.
 *
 * Significance and attention are different questions. A merged PR is highly significant and
 * needs nobody; a one-line review comment can be low significance and block everything. Keeping
 * them separate is what stops the feed's ranking from quietly becoming the attention list.
 */
export type Importance = "MAJOR" | "NOTABLE" | "ROUTINE" | "NOISE";

const IMPORTANCE_SCORE: Record<Importance, number> = {
  MAJOR: 90,
  NOTABLE: 60,
  ROUTINE: 30,
  NOISE: 10,
};

export function importanceScore(importance: Importance): number {
  return IMPORTANCE_SCORE[importance];
}

/** Default significance per event type. Ingestors may override for a specific occurrence. */
export const DEFAULT_IMPORTANCE: Record<EventType, Importance> = {
  PR_OPENED: "NOTABLE",
  PR_UPDATED: "ROUTINE",
  PR_READY_FOR_REVIEW: "MAJOR",
  PR_REVIEWED: "NOTABLE",
  PR_CHANGES_REQUESTED: "MAJOR",
  PR_MERGED: "MAJOR",
  PR_CLOSED: "NOTABLE",
  CI_STARTED: "NOISE",
  CI_PASSED: "ROUTINE",
  CI_FAILED: "MAJOR",
  ISSUE_OPENED: "NOTABLE",
  ISSUE_UPDATED: "ROUTINE",
  WORKSTREAM_CREATED: "NOTABLE",
  WORKSTREAM_PHASE_CHANGED: "MAJOR",
  WORKSTREAM_BLOCKED: "MAJOR",
  WORKSTREAM_UNBLOCKED: "NOTABLE",
  WORKSTREAM_COMPLETED: "MAJOR",
  DECISION_ADDED: "MAJOR",
  PROJECT_MODEL_CHANGED: "NOTABLE",
  SESSION_STARTED: "ROUTINE",
  SESSION_CHECKPOINTED: "ROUTINE",
  SESSION_BLOCKED: "MAJOR",
  SESSION_COMPLETED: "NOTABLE",
  SYNC_FAILED: "NOTABLE",
};

/**
 * A normalized event.
 *
 * `ownerAttentionState` from the design plan is deliberately absent. Attention is a derived,
 * recomputable view (plan §7.6); freezing it onto an immutable event would mean a rule change
 * could never correct history. Attention lives in `AttentionItem`, keyed back to entities.
 */
export interface CompanionEvent {
  /** Deterministic: derived from `sourceFingerprint`, so re-ingestion yields the same id. */
  readonly id: string;
  readonly projectId: string;
  readonly eventType: EventType;
  readonly source: SourceRef;
  readonly actor: Actor;
  /** When it happened in the source system. */
  readonly occurredAt: string;
  /** When the Companion first recorded it. */
  readonly ingestedAt: string;
  readonly workstreamId?: string;
  readonly pullRequestNumber?: number;
  readonly sessionId?: string;
  readonly importance: Importance;
  /** Deterministic one-line description. Never model-generated; a model may add a richer one. */
  readonly summaryShort: string;
  readonly summaryDetail?: string;
  /** Narrow, source-shaped payload retained for projection and debugging. Never rendered raw. */
  readonly raw?: Readonly<Record<string, unknown>>;
  /** Idempotency key. Identical source facts produce an identical fingerprint. */
  readonly sourceFingerprint: string;
}

/**
 * Everything needed to create an event except the fields the ledger derives.
 *
 * `fingerprintParts` is the normalizer declaring *what makes this occurrence distinct*.
 * Include the facts whose change means "something new happened"; exclude anything that churns
 * without meaning (poll timestamps, ordering, pagination cursors). Get this wrong in one
 * direction and the feed duplicates; wrong in the other and real changes vanish.
 */
export type EventDraft = Omit<
  CompanionEvent,
  "id" | "ingestedAt" | "sourceFingerprint" | "importance"
> & {
  importance?: Importance;
  fingerprintParts: FingerprintPart[];
};

export type FingerprintPart = string | number | boolean | null | undefined;

export function isPullRequestEvent(e: CompanionEvent): boolean {
  return e.eventType.startsWith("PR_") || e.eventType.startsWith("CI_");
}

export function isWorkstreamEvent(e: CompanionEvent): boolean {
  return e.eventType.startsWith("WORKSTREAM_");
}

export function isSessionEvent(e: CompanionEvent): boolean {
  return e.eventType.startsWith("SESSION_");
}
