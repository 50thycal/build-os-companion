/**
 * "What changed since I last checked."
 *
 * Not a chronological dump. The owner has been away and wants to know what the time away cost
 * them, which is a different question from what happened in what order. So events are grouped
 * by what they mean — something now needs you, something stopped needing you, something
 * finished, something broke, something moved without you — and collapsed per entity, because
 * eleven events about one pull request is one thing that happened to one pull request.
 *
 * The window is a sequence range, never a time range. See `SqliteEventLedger.afterSequence`.
 */

import type { CompanionEvent, EventType } from "../domain/events.ts";
import { importanceScore } from "../domain/events.ts";
import type { Severity } from "../domain/attention.ts";
import { severityRank } from "../domain/attention.ts";
import type { SqliteEventLedger } from "../ledger/sqlite-ledger.ts";
import type { CompanionStore, ReadCursor, StoredProject, TrackedAttentionItem } from "../store/store.ts";

export const CHANGE_CATEGORIES = [
  "NEEDS_YOU",
  "RESOLVED",
  "FINISHED",
  "FAILED",
  "IN_FLIGHT",
  "AUTONOMOUS",
] as const;

export type ChangeCategory = (typeof CHANGE_CATEGORIES)[number];

export const CATEGORY_TITLES: Record<ChangeCategory, string> = {
  NEEDS_YOU: "Now needs you",
  RESOLVED: "Stopped needing you",
  FINISHED: "Finished",
  FAILED: "Broke",
  IN_FLIGHT: "Moved forward",
  AUTONOMOUS: "Happened without you",
};

export interface ChangeEntry {
  projectId: string;
  projectName: string;
  entityType: "PULL_REQUEST" | "WORKSTREAM" | "SESSION" | "PROJECT";
  /** `pr:142`, `WS-001`, a session id, or the project id. */
  entityId: string;
  /** `PR #142`, `WS-001`. What the owner calls it. */
  entityLabel: string;
  headline: string;
  detail?: string;
  severity?: Severity;
  /** Every event collapsed into this entry, so a claim can always be expanded to its facts. */
  eventIds: string[];
  occurredAt: string;
  sourceUrl?: string;
}

export interface ChangeGroup {
  category: ChangeCategory;
  title: string;
  entries: ChangeEntry[];
}

export interface SinceLastChecked {
  ownerUserId: string;
  generatedAt: string;
  /** Where the owner had read up to. Absent when they have never marked anything read. */
  cursor?: ReadCursor;
  fromSequence: number;
  /** What `markChecked` would be called with to accept this briefing. */
  toSequence: number;
  /**
   * True when there is no cursor yet. The first look is a backfill, not news, and saying so is
   * more honest than presenting a repository's entire history as having just happened.
   */
  isFirstLook: boolean;
  groups: ChangeGroup[];
  newAttention: TrackedAttentionItem[];
  resolvedAttention: TrackedAttentionItem[];
  /** Raw event count in the window, before collapsing. */
  eventCount: number;
  /** True when nothing at all happened. */
  quiet: boolean;
}

const FINISHED: ReadonlySet<EventType> = new Set([
  "PR_MERGED",
  "WORKSTREAM_COMPLETED",
  "SESSION_COMPLETED",
]);

const FAILED: ReadonlySet<EventType> = new Set(["CI_FAILED", "SYNC_FAILED", "SESSION_BLOCKED", "WORKSTREAM_BLOCKED"]);

/**
 * Churn that is real but not worth a line on its own.
 *
 * These still appear, folded into an entry alongside something that matters. What they never do
 * is generate an entry by themselves — a poll that observed a check starting is not news.
 */
const CHURN: ReadonlySet<EventType> = new Set(["CI_STARTED", "PR_UPDATED", "SESSION_CHECKPOINTED"]);

function entityOf(event: CompanionEvent): { type: ChangeEntry["entityType"]; id: string; label: string } {
  if (event.pullRequestNumber !== undefined) {
    return { type: "PULL_REQUEST", id: `pr:${event.pullRequestNumber}`, label: `PR #${event.pullRequestNumber}` };
  }
  if (event.workstreamId !== undefined) {
    return { type: "WORKSTREAM", id: event.workstreamId, label: event.workstreamId };
  }
  if (event.sessionId !== undefined) {
    return { type: "SESSION", id: event.sessionId, label: `${event.actor.name} session` };
  }
  if (event.eventType === "DECISION_ADDED") {
    // Decisions carry no entity id of their own, and letting them fall through to the project
    // collapses every decision recorded in a window into one line reading "Project".
    const decision = (event.raw as { decision?: { decisionId?: string } } | undefined)?.decision;
    if (decision?.decisionId) {
      return { type: "PROJECT", id: `decision:${decision.decisionId}`, label: decision.decisionId };
    }
  }
  return { type: "PROJECT", id: event.projectId, label: "Project" };
}

/**
 * Which section an entity's events belong in.
 *
 * One entity lands in exactly one section — the most consequential thing that happened to it.
 * A pull request that had CI fail and then merged belongs under Finished, not in both places,
 * because the owner is reading this to find out where things stand and being told the same PR
 * twice makes that harder rather than more complete.
 */
function categorize(
  events: CompanionEvent[],
  attentionSeverity: Severity | undefined,
  resolved: boolean,
): ChangeCategory {
  if (events.some((e) => FINISHED.has(e.eventType))) return "FINISHED";
  if (attentionSeverity && severityRank(attentionSeverity) >= severityRank("MEDIUM")) return "NEEDS_YOU";
  if (resolved) return "RESOLVED";
  if (events.some((e) => FAILED.has(e.eventType))) return "FAILED";

  // Nothing needs the owner and nothing broke. Who moved it decides how it reads: work an
  // agent did while the owner was away is the thing they most want distinguished from their own.
  const autonomous = events.every((e) => e.actor.type === "AGENT" || e.actor.type === "BOT" || e.actor.type === "SYSTEM");
  return autonomous ? "AUTONOMOUS" : "IN_FLIGHT";
}

function pickHeadline(events: CompanionEvent[]): CompanionEvent {
  const meaningful = events.filter((e) => !CHURN.has(e.eventType));
  const pool = meaningful.length > 0 ? meaningful : events;
  return [...pool].sort((a, b) => {
    const byImportance = importanceScore(b.importance) - importanceScore(a.importance);
    if (byImportance !== 0) return byImportance;
    return b.occurredAt.localeCompare(a.occurredAt);
  })[0]!;
}

function summarize(events: CompanionEvent[], headline: CompanionEvent): string | undefined {
  const others = events.filter((e) => e.id !== headline.id && !CHURN.has(e.eventType));
  if (others.length === 0) {
    const churn = events.length - 1;
    return churn > 0 ? `Plus ${churn} routine update${churn === 1 ? "" : "s"}.` : undefined;
  }
  const named = others.slice(0, 2).map((e) => e.summaryShort);
  const rest = others.length - named.length;
  return rest > 0 ? `${named.join("; ")}; and ${rest} more.` : `${named.join("; ")}.`;
}

export interface SinceInput {
  store: CompanionStore;
  ledger: SqliteEventLedger;
  ownerUserId: string;
  now: Date;
  /** Limit to one project. Absent means every followed project. */
  projectId?: string;
}

export function buildSinceLastChecked(input: SinceInput): SinceLastChecked {
  const { store, ledger, ownerUserId, now } = input;

  const cursor = store.getReadCursor(ownerUserId);
  const fromSequence = cursor?.lastSeq ?? 0;
  const toSequence = ledger.latestSequence();

  const projects = new Map<string, StoredProject>(
    store.listProjects({ includeDisabled: true }).map((p) => [p.id, p]),
  );
  const nameOf = (id: string) => projects.get(id)?.displayName ?? projects.get(id)?.repositoryFullName ?? id;

  const sequenced = ledger.afterSequence(fromSequence, { projectId: input.projectId });
  const events = sequenced.map((s) => s.event);

  // Attention is compared against when the owner last checked, not against the event sequence.
  // See `CompanionStore.attentionOpenedAfter`.
  const checkedAt = cursor?.lastCheckedAt;
  const newAttention = store
    .attentionOpenedAfter(checkedAt)
    .filter((a) => !input.projectId || a.projectId === input.projectId);
  const resolvedAttention = store
    .attentionResolvedAfter(checkedAt)
    .filter((a) => !input.projectId || a.projectId === input.projectId);

  // Attention is keyed to entities, and so are the groups, so the two can be joined.
  const severityByEntity = new Map<string, Severity>();
  for (const item of newAttention) severityByEntity.set(`${item.projectId}|${item.entityId}`, item.severity);
  const resolvedEntities = new Set(resolvedAttention.map((a) => `${a.projectId}|${a.entityId}`));

  const grouped = new Map<string, CompanionEvent[]>();
  for (const event of events) {
    const entity = entityOf(event);
    const key = `${event.projectId}|${entity.id}`;
    grouped.set(key, [...(grouped.get(key) ?? []), event]);
  }

  const entries = new Map<ChangeCategory, ChangeEntry[]>();
  const seenEntities = new Set<string>();

  for (const [key, group] of grouped) {
    seenEntities.add(key);
    const headline = pickHeadline(group);
    const entity = entityOf(headline);
    const severity = severityByEntity.get(key);
    const category = categorize(group, severity, resolvedEntities.has(key));

    const entry: ChangeEntry = {
      projectId: headline.projectId,
      projectName: nameOf(headline.projectId),
      entityType: entity.type,
      entityId: entity.id,
      entityLabel: entity.label,
      headline: headline.summaryShort,
      detail: summarize(group, headline),
      severity,
      eventIds: group.map((e) => e.id).sort(),
      occurredAt: group.map((e) => e.occurredAt).sort().at(-1)!,
      sourceUrl: headline.source.sourceUrl,
    };

    entries.set(category, [...(entries.get(category) ?? []), entry]);
  }

  // An attention item can open without any event of its own — a pull request goes stale because
  // time passed, not because anything happened. Those would be invisible in an event-derived
  // briefing, which is exactly the kind of silence the Needs Me screen exists to prevent.
  for (const item of newAttention) {
    const key = `${item.projectId}|${item.entityId}`;
    if (seenEntities.has(key)) continue;
    entries.set("NEEDS_YOU", [
      ...(entries.get("NEEDS_YOU") ?? []),
      {
        projectId: item.projectId,
        projectName: nameOf(item.projectId),
        entityType: item.entityType,
        entityId: item.entityId,
        entityLabel: item.entityType === "PULL_REQUEST" ? `PR #${item.entityId.replace("pr:", "")}` : item.entityId,
        headline: item.reasonText,
        detail: item.recommendedAction,
        severity: item.severity,
        eventIds: [],
        occurredAt: item.firstSeenAt,
        sourceUrl: item.evidence[0]?.sourceUrl,
      },
    ]);
  }

  const groups: ChangeGroup[] = CHANGE_CATEGORIES.filter((c) => (entries.get(c) ?? []).length > 0).map((category) => ({
    category,
    title: CATEGORY_TITLES[category],
    entries: (entries.get(category) ?? []).sort((a, b) => {
      const bySeverity = severityRank(b.severity ?? "NONE") - severityRank(a.severity ?? "NONE");
      if (bySeverity !== 0) return bySeverity;
      return b.occurredAt.localeCompare(a.occurredAt) || a.entityId.localeCompare(b.entityId);
    }),
  }));

  return {
    ownerUserId,
    generatedAt: now.toISOString(),
    cursor,
    fromSequence,
    toSequence,
    isFirstLook: cursor === undefined,
    groups,
    newAttention,
    resolvedAttention,
    eventCount: events.length,
    quiet: groups.length === 0,
  };
}
