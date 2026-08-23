/**
 * Attention model.
 *
 * Every attention item must explain itself: a reason code the product can rely on, and a
 * sentence the owner can read. There is deliberately no opaque urgency score — a badge the
 * owner cannot interrogate is a badge they will learn to ignore.
 */

import type { SourceRef } from "./provenance.ts";

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "NONE";

const SEVERITY_RANK: Record<Severity, number> = {
  CRITICAL: 50,
  HIGH: 40,
  MEDIUM: 30,
  LOW: 20,
  NONE: 0,
};

export function severityRank(s: Severity): number {
  return SEVERITY_RANK[s];
}

/** `NONE` items are recorded rather than dropped, so suppression is explainable too. */
export function needsOwner(severity: Severity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK.MEDIUM;
}

export const REASON_CODES = [
  "OWNER_DECISION_REQUIRED",
  "BUILD_CARD_AWAITING_APPROVAL",
  "PR_WAITING_FOR_OWNER_REVIEW",
  "PR_CI_FAILED",
  "PR_STALE",
  "REVIEW_CHANGES_REQUESTED",
  "MERGE_CONFLICT",
  "WORKSTREAM_BLOCKED",
  "WORKSTREAM_STALE",
  "SESSION_BLOCKED",
  "SESSION_STALE",
  "BUILD_OS_INTEGRITY",
  "SYNC_FAILING",
  /** Explicit suppression: something looked alarming and is not. Severity NONE. */
  "AUTONOMOUS_PROGRESS",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

export type AttentionEntityType = "PULL_REQUEST" | "WORKSTREAM" | "SESSION" | "PROJECT";

export interface AttentionItem {
  /** Deterministic: same situation, same id, so items are stable across recomputation. */
  id: string;
  projectId: string;
  entityType: AttentionEntityType;
  /** `pr:84`, `WS-004`, a session id, or the project id. */
  entityId: string;
  severity: Severity;
  reasonCode: ReasonCode;
  /** One sentence the owner can act on, naming the specific thing. */
  reasonText: string;
  recommendedAction: string;
  /** What the rule looked at. Every claim traces back to a source. */
  evidence: SourceRef[];
  createdAt: string;
  clearedAt?: string;
}

/** Thresholds are configuration, not constants: real use will move them. */
export interface AttentionThresholds {
  /** An open PR untouched for this long, while expected to be moving. */
  stalePullRequestHours: number;
  /** An ACTIVE workstream whose file has not changed for this long. */
  staleWorkstreamDays: number;
  /** An ACTIVE session that has not checkpointed for this long becomes UNKNOWN. */
  staleSessionHours: number;
}

export const DEFAULT_THRESHOLDS: AttentionThresholds = {
  stalePullRequestHours: 72,
  staleWorkstreamDays: 7,
  staleSessionHours: 4,
};
