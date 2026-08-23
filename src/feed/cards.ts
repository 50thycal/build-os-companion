/**
 * Feed cards.
 *
 * A card is not an activity log line. It answers five questions the owner actually has:
 * what changed, why it matters, where it is now, is anything blocked, and what happens next.
 *
 * Card *content* is assembled here as data. Rendering is somebody else's problem — which is what
 * keeps a web UI, a written briefing, and eventually a podcast reading the same thing.
 */

import { importanceScore, type CompanionEvent } from "../domain/events.ts";
import { severityRank, type AttentionItem, type Severity } from "../domain/attention.ts";
import type { ProjectState, PullRequestState, WorkstreamState } from "../domain/state.ts";

export interface FeedCard {
  id: string;
  projectId: string;
  projectName: string;
  /** `PR #84`, `WS-004`, `claude session`. */
  entityLabel: string;
  entityType: AttentionItem["entityType"];
  entityId: string;
  occurredAt: string;
  headline: string;
  whatChanged: string;
  whyItMatters?: string;
  currentState: string;
  /** Always populated. `Nothing.` is an answer the owner needs to see. */
  needsYou: string;
  nextStep?: string;
  sourceUrl?: string;
  severity: Severity;
  rank: number;
  /** Events collapsed into this card, so a card can always be expanded back to its facts. */
  eventIds: string[];
}

export interface FeedInput {
  projectId: string;
  projectName: string;
  state: ProjectState;
  events: CompanionEvent[];
  attention: AttentionItem[];
  now: Date;
  /** Only events after this are considered. Absent means everything. */
  since?: string;
}

function entityKeyOf(event: CompanionEvent): string | undefined {
  if (event.pullRequestNumber !== undefined) return `pr:${event.pullRequestNumber}`;
  if (event.sessionId !== undefined) return `session:${event.sessionId}`;
  if (event.workstreamId !== undefined) return `ws:${event.workstreamId}`;
  if (event.eventType === "DECISION_ADDED") {
    const decision = (event.raw as { decision?: { decisionId?: string } } | undefined)?.decision;
    return decision?.decisionId ? `decision:${decision.decisionId}` : "project";
  }
  return "project";
}

function describePullRequest(pr: PullRequestState): string {
  const review =
    pr.reviewState === "NONE" ? "no review yet" : pr.reviewState.toLowerCase().replace(/_/g, " ");
  const ci = pr.ciState === "NONE" ? "no CI" : `CI ${pr.ciState.toLowerCase()}`;
  const merge =
    pr.mergeability === "CONFLICTED"
      ? ", conflicts with the base branch"
      : pr.mergeability === "BLOCKED"
        ? ", merge blocked"
        : "";
  return `${ci}, ${review}${merge}.`;
}

function describeWorkstream(ws: WorkstreamState): string {
  const phase = ws.phase ? ws.phase.replace(/_/g, " ").toLowerCase() : "phase unknown";
  const status = ws.status ? ws.status.toLowerCase() : "status unknown";
  const decisions =
    ws.openDecisions.length > 0
      ? `, ${ws.openDecisions.length} open decision${ws.openDecisions.length === 1 ? "" : "s"}`
      : "";
  return `In ${phase}, ${status}${decisions}.`;
}

/**
 * Collapse low-value churn.
 *
 * Several events about one entity become one card carrying the most significant headline. This
 * is what turns "7 commits + 3 CI reruns + a description edit" into "PR #84 moved into review;
 * CI is now green" — and it is why the feed can survive the owner being away for a week.
 */
function pickHeadlineEvent(events: CompanionEvent[]): CompanionEvent {
  return [...events].sort((a, b) => {
    const byImportance = importanceScore(b.importance) - importanceScore(a.importance);
    if (byImportance !== 0) return byImportance;
    return b.occurredAt.localeCompare(a.occurredAt);
  })[0]!;
}

function summarizeChange(events: CompanionEvent[], headline: CompanionEvent): string {
  const others = events.filter((e) => e.id !== headline.id);
  if (others.length === 0) return headline.summaryShort;

  const noteworthy = others
    .filter((e) => importanceScore(e.importance) >= importanceScore("NOTABLE"))
    .slice(0, 2)
    .map((e) => e.summaryShort);

  if (noteworthy.length > 0) {
    return `${headline.summaryShort} Also: ${noteworthy.join("; ")}.`;
  }
  return `${headline.summaryShort} (plus ${others.length} routine update${others.length === 1 ? "" : "s"}.)`;
}

export function buildFeed(input: FeedInput): FeedCard[] {
  const { state, projectId, projectName } = input;

  const events = input.events
    .filter((e) => e.projectId === projectId)
    .filter((e) => (input.since ? e.occurredAt > input.since : true));

  const grouped = new Map<string, CompanionEvent[]>();
  for (const event of events) {
    const key = entityKeyOf(event) ?? "project";
    grouped.set(key, [...(grouped.get(key) ?? []), event]);
  }

  const attentionByEntity = new Map<string, AttentionItem>();
  for (const item of input.attention) {
    const key =
      item.entityType === "WORKSTREAM"
        ? `ws:${item.entityId}`
        : item.entityType === "SESSION"
          ? `session:${item.entityId}`
          : item.entityType === "PULL_REQUEST"
            ? item.entityId
            : "project";
    const existing = attentionByEntity.get(key);
    if (!existing || severityRank(item.severity) > severityRank(existing.severity)) {
      attentionByEntity.set(key, item);
    }
  }

  const prByNumber = new Map(state.pullRequests.map((pr) => [pr.number, pr]));
  const wsById = new Map(state.workstreams.map((ws) => [ws.workstreamId, ws]));
  const sessionById = new Map(state.sessions.map((s) => [s.sessionId, s]));

  const cards: FeedCard[] = [];

  for (const [key, group] of grouped) {
    const headline = pickHeadlineEvent(group);
    const attention = attentionByEntity.get(key);
    const severity = attention?.severity ?? "NONE";

    let entityLabel = "Project";
    let currentState = "No current state recorded.";
    let nextStep: string | undefined;
    let whyItMatters: string | undefined;
    let entityType: AttentionItem["entityType"] = "PROJECT";
    let entityId = projectId;

    if (key.startsWith("pr:")) {
      const pr = prByNumber.get(Number(key.slice(3)));
      entityType = "PULL_REQUEST";
      entityId = key;
      entityLabel = `PR #${key.slice(3)}`;
      if (pr) {
        currentState = describePullRequest(pr);
        if (pr.workstreamIds.length > 0) {
          whyItMatters = `Carries ${pr.workstreamIds.join(", ")}.`;
          nextStep = wsById.get(pr.workstreamIds[0]!)?.nextStep;
        }
      }
    } else if (key.startsWith("ws:")) {
      const ws = wsById.get(key.slice(3));
      entityType = "WORKSTREAM";
      entityId = key.slice(3);
      entityLabel = entityId;
      if (ws) {
        currentState = describeWorkstream(ws);
        nextStep = ws.nextStep;
        whyItMatters = ws.goal;
      }
    } else if (key.startsWith("session:")) {
      const session = sessionById.get(key.slice(8));
      entityType = "SESSION";
      entityId = key.slice(8);
      entityLabel = `${session?.agentName ?? session?.agent ?? "agent"} session`;
      if (session) {
        currentState = `${session.status.toLowerCase()}${
          session.inProgress.length > 0 ? `, working on ${session.inProgress[0]}` : ""
        }.`;
        nextStep = session.nextStep;
        whyItMatters = session.objective;
      }
    } else if (key.startsWith("decision:")) {
      entityType = "PROJECT";
      entityId = key;
      entityLabel = key.slice(9);
      currentState = "Recorded in the project's decision log.";
      whyItMatters = headline.summaryDetail;
    }

    cards.push({
      id: `card_${headline.id.slice(4)}`,
      projectId,
      projectName,
      entityLabel,
      entityType,
      entityId,
      occurredAt: headline.occurredAt,
      headline: headline.summaryShort,
      whatChanged: summarizeChange(group, headline),
      whyItMatters,
      currentState,
      needsYou: attention && severityRank(severity) >= severityRank("MEDIUM")
        ? attention.reasonText
        : "Nothing.",
      nextStep,
      sourceUrl: headline.source.sourceUrl,
      severity,
      rank: 0,
      eventIds: group.map((e) => e.id).sort(),
    });
  }

  return rankFeed(cards, input.now);
}

/**
 * Ranking is a blend, not pure chronology: what needs the owner comes first, then significance,
 * then recency. A three-day-old blocking decision outranks a green CI run from a minute ago.
 */
export function rankFeed(cards: FeedCard[], now: Date): FeedCard[] {
  const scored = cards.map((card) => {
    const ageHours = Math.max(
      0,
      (now.getTime() - new Date(card.occurredAt).getTime()) / 3_600_000,
    );
    const recency = Math.max(0, 40 - ageHours);
    const rank = severityRank(card.severity) * 4 + recency;
    return { ...card, rank: Math.round(rank * 100) / 100 };
  });

  return scored.sort((a, b) => {
    if (b.rank !== a.rank) return b.rank - a.rank;
    return b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id);
  });
}
