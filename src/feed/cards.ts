/**
 * Feed cards.
 *
 * A card is not an activity log line. It answers five questions the owner actually has:
 * what changed, why it matters, where it is now, is anything blocked, and what happens next.
 *
 * Card *content* is assembled here as data. Rendering is somebody else's problem — which is what
 * keeps a web UI, a written briefing, and eventually a podcast reading the same thing.
 */

import { importanceScore, type CompanionEvent, type EventType } from "../domain/events.ts";
import { severityRank, type AttentionItem, type Severity } from "../domain/attention.ts";
import type { IntegrityWarning, ProjectState, PullRequestState, WorkstreamState } from "../domain/state.ts";
import {
  describePhase,
  describePullRequestStanding,
  isSettled,
  relativeTime,
} from "../domain/describe.ts";

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
  /**
   * How this entity got here: the collapsed events as a compact past-tense trail, oldest first.
   *
   * Separate from `whatChanged` so that a card can carry its history without the history
   * competing with the headline. Absent when there is only one event and so no trail to tell.
   */
  history?: string;
  /**
   * Where the durable record and GitHub disagree about this entity, in the owner's words.
   *
   * The Companion never resolves such a disagreement by picking a winner, so a card that has one
   * says so on its face. This is the sentence that makes "the workstream says blocked, the PR
   * merged" visible instead of quietly normalized into one of the two.
   */
  contradictions?: string[];
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

/**
 * A short past-tense label for an event, for the history trail.
 *
 * Deliberately not `summaryShort`: that already names the entity, and a trail of full summaries
 * repeats "PR #146" four times to say one thing happened to it four times.
 */
const EVENT_PHRASE: Partial<Record<EventType, string>> = {
  PR_OPENED: "opened",
  PR_UPDATED: "updated",
  PR_READY_FOR_REVIEW: "marked ready for review",
  PR_REVIEWED: "reviewed",
  PR_CHANGES_REQUESTED: "changes requested",
  PR_MERGED: "merged",
  PR_CLOSED: "closed without merging",
  CI_STARTED: "checks started",
  CI_PASSED: "checks passed",
  CI_FAILED: "checks failed",
  ISSUE_OPENED: "opened",
  ISSUE_UPDATED: "updated",
  WORKSTREAM_CREATED: "first seen",
  WORKSTREAM_PHASE_CHANGED: "phase changed",
  WORKSTREAM_BLOCKED: "blocked",
  WORKSTREAM_UNBLOCKED: "unblocked",
  WORKSTREAM_COMPLETED: "completed",
  DECISION_ADDED: "recorded",
  PROJECT_MODEL_CHANGED: "project model changed",
  SESSION_STARTED: "session started",
  SESSION_CHECKPOINTED: "checkpointed",
  SESSION_BLOCKED: "session blocked",
  SESSION_COMPLETED: "session finished",
  SYNC_FAILED: "sync failed",
};

/**
 * The workstream's canonical current state — one sentence, from the durable artifact only.
 *
 * This is the layer that owns phase and status, so this sentence is allowed to be short and
 * declarative. What it must never do is blend in an event summary or a GitHub fact to make
 * itself sound more current: where those disagree with it, the disagreement is a separate
 * output on the card, not an edit to this line.
 */
function describeWorkstream(ws: WorkstreamState): string {
  const phase = describePhase(ws.phase);
  const status = ws.status ? ws.status.toLowerCase() : "status unknown";
  const decisions =
    ws.openDecisions.length > 0
      ? `, ${ws.openDecisions.length} open decision${ws.openDecisions.length === 1 ? "" : "s"}`
      : "";
  return `The workstream file says ${phase}, ${status}${decisions}.`;
}

/**
 * Collapse low-value churn.
 *
 * Several events about one entity become one card carrying the most significant headline. This
 * is what turns "7 commits + 3 CI reruns + a description edit" into "PR #84 moved into review;
 * CI is now green" — and it is why the feed can survive the owner being away for a week.
 *
 * Most significant first, then most recent *within* that band. The order matters in both
 * directions: recency alone would let a routine push outrank the merge it followed, and
 * importance alone would let an older `WORKSTREAM_BLOCKED` outrank the newer transition that
 * resolved it, so the card would announce a blockage that had already lifted.
 */
function pickHeadlineEvent(events: CompanionEvent[]): CompanionEvent {
  return [...events].sort((a, b) => {
    const byImportance = importanceScore(b.importance) - importanceScore(a.importance);
    if (byImportance !== 0) return byImportance;
    return b.occurredAt.localeCompare(a.occurredAt);
  })[0]!;
}

/** How many steps of the trail are worth showing before it becomes a log again. */
const TRAIL_LIMIT = 4;

/**
 * The collapsed events as a trail, oldest first: `Opened 6 h ago; merged 17 min ago.`
 *
 * This replaced a rule that appended `Also: <summary>` for every collapsed event above
 * `ROUTINE`, which produced `PR #146 merged: … Also: PR #146 opened: ….` — technically
 * lossless, and useless. Two things were wrong with it. It repeated the headline's own subject
 * back at the reader, and it gave the *earlier* event equal billing with the outcome, so a card
 * about a merge read as though opening and merging were two competing pieces of news.
 *
 * The trail keeps every collapsed event, subordinate to the headline and in the order they
 * happened, which is the order that explains anything. The headline appears in it too: a merge
 * is more legible as the end of a sequence than as a fact floating beside its own beginning.
 */
function describeHistory(events: CompanionEvent[], now: Date): string | undefined {
  if (events.length < 2) return undefined;

  const ordered = [...events].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  // One phrase per kind of thing that happened, keeping the latest occurrence of each: five
  // pushes are one "updated", and the useful timestamp is the last one.
  const byPhrase = new Map<string, CompanionEvent>();
  for (const event of ordered) {
    const phrase = EVENT_PHRASE[event.eventType];
    if (!phrase) continue;
    byPhrase.set(phrase, event);
  }
  if (byPhrase.size < 2) return undefined;

  const steps = [...byPhrase.entries()].sort((a, b) => a[1].occurredAt.localeCompare(b[1].occurredAt));
  const shown = steps.slice(-TRAIL_LIMIT);
  const dropped = steps.length - shown.length;

  const trail = shown.map(([phrase, event]) => `${phrase} ${relativeTime(event.occurredAt, now)}`);
  const sentence = `${trail.join("; ")}.`;
  return dropped > 0 ? `…${sentence} (${dropped} earlier step${dropped === 1 ? "" : "s"} not shown.)` : capitalize(sentence);
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
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

  // Integrity findings, indexed by the entity they are about. A card's job is to show the
  // contradiction on the thing it concerns, not to leave it on a project-level list the owner
  // has to go and find.
  const findingsByWorkstream = new Map<string, IntegrityWarning[]>();
  const findingsByPr = new Map<string, IntegrityWarning[]>();
  for (const warning of state.integrityWarnings) {
    if (warning.workstreamId) {
      findingsByWorkstream.set(warning.workstreamId, [
        ...(findingsByWorkstream.get(warning.workstreamId) ?? []),
        warning,
      ]);
    }
    const pr = /PR #(\d+)/.exec(warning.message);
    if (pr) {
      const key = `pr:${pr[1]}`;
      findingsByPr.set(key, [...(findingsByPr.get(key) ?? []), warning]);
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
    let contradictions: string[] | undefined;

    if (key.startsWith("pr:")) {
      const pr = prByNumber.get(Number(key.slice(3)));
      entityType = "PULL_REQUEST";
      entityId = key;
      entityLabel = `PR #${key.slice(3)}`;
      if (pr) {
        currentState = describePullRequestStanding(pr, input.now);
        if (pr.workstreamIds.length > 0) {
          whyItMatters = `Carries ${pr.workstreamIds.join(", ")}.`;
          // A settled pull request has no next step of its own. Borrowing its workstream's was
          // how a merged PR came to tell the owner to go and do something about it.
          nextStep = isSettled(pr.lifecycle)
            ? undefined
            : wsById.get(pr.workstreamIds[0]!)?.nextStep;
        }
        contradictions = findingsByPr.get(key)?.map((w) => w.message);
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
        contradictions = findingsByWorkstream.get(entityId)?.map((w) => w.message);
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
      whatChanged: headline.summaryShort,
      history: describeHistory(group, input.now),
      contradictions: contradictions && contradictions.length > 0 ? contradictions : undefined,
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
