/**
 * The topic suggestion engine.
 *
 * Deterministic rules over current project state, producing proposals for standalone episodes.
 * It decides *what is worth understanding*, which is a different question from `attention`'s
 * *what needs you* and from the feed's *what changed* — and, per this codebase's standing rule
 * that each surface answers exactly one question, it is ordered by its own answer alone.
 *
 * Structure follows `attention/engine.ts` closely and on purpose: rules per entity kind returning
 * drafts, a content-hashed id so the same situation is the same suggestion forever, an injected
 * clock, and an explicit record of what was considered and rejected rather than a silent absence.
 *
 * What it will not do:
 *
 * - **Fire on a single pull request.** Every rule requires a cluster. "Avoid suggesting an episode
 *   for every PR or normal maintenance change" is the idea note's central editorial instruction,
 *   and a rule that keys off one merge cannot honour it.
 * - **Generate anything.** A suggestion is a proposal. Generation happens only when the owner
 *   approves one, and then from the stored proposal rather than a recomputed one.
 * - **Invent a claim.** Titles and beats are assembled from workstream goals, decision titles and
 *   pull request titles that already exist. The editorial judgment is the engine's; the facts
 *   are the artifacts'.
 */

import { createHash } from "node:crypto";

import type { FactRef } from "../briefing/fact-pack.ts";
import {
  DEFAULT_SUGGESTION_THRESHOLDS,
  worthSuggesting,
  type SuggestionReasonCode,
  type SuggestionScope,
  type SuggestionThresholds,
  type TopicSuggestion,
} from "../domain/podcast-suggestion.ts";
import type { SourceRef } from "../domain/provenance.ts";
import type { DecisionRecord, ProjectState, PullRequestState, WorkstreamState } from "../domain/state.ts";

export interface SuggestionInput {
  state: ProjectState;
  projectName: string;
  now: Date;
  thresholds?: SuggestionThresholds;
}

/** A rule's output before the engine stamps identity and time onto it. */
interface DraftSuggestion {
  entityId: string;
  title: string;
  whyNow: string;
  whatYouWouldLearn: string[];
  freshness: string;
  scope: SuggestionScope;
  reasonCode: SuggestionReasonCode;
  score: number;
  scoreReasons: string[];
  refs: FactRef[];
  evidence: SourceRef[];
}

/**
 * A suggestion's id, derived from what it is about rather than when it was made.
 *
 * The reason code is part of the key: one workstream can legitimately carry both a completed-arc
 * episode and an open-tradeoff one, and collapsing them would let dismissing the first silently
 * suppress the second.
 */
function suggestionId(projectId: string, entityId: string, reason: SuggestionReasonCode): string {
  const hash = createHash("sha256")
    .update([projectId, entityId, reason].join("|"), "utf8")
    .digest("hex");
  return `sug_${hash.slice(0, 20)}`;
}

const wsRef = (projectId: string, ws: WorkstreamState): FactRef => ({
  kind: "WORKSTREAM",
  id: ws.workstreamId,
  projectId,
  url: ws.source.sourceUrl,
});

const prRef = (projectId: string, pr: PullRequestState): FactRef => ({
  kind: "PULL_REQUEST",
  id: `pr:${pr.number}`,
  projectId,
  url: pr.sourceUrl,
});

const decisionRef = (projectId: string, decision: DecisionRecord): FactRef => ({
  kind: "DECISION",
  id: decision.decisionId,
  projectId,
  url: decision.sourceUrl,
});

/**
 * The judgment that a topic is worth an episode is the engine's own, so it is recorded as
 * `INFERENCE` — the weakest precedence this codebase has. The artifacts it read carry their own
 * refs alongside it, and those are not inferences.
 */
const editorialRef = (entityId: string, at: string): SourceRef => ({
  sourceType: "INFERENCE",
  sourceId: `podcast-suggestion:${entityId}`,
  observedAt: at,
});

const finished = (ws: WorkstreamState): boolean =>
  ws.status === "COMPLETE" || ws.phase === "COMPLETE";

function mergedPullRequestsFor(state: ProjectState, ws: WorkstreamState): PullRequestState[] {
  return state.pullRequests
    .filter((pr) => pr.lifecycle === "MERGED")
    .filter((pr) => pr.workstreamIds.includes(ws.workstreamId) || ws.relatedPrNumbers.includes(pr.number))
    .sort((a, b) => (a.mergedAt ?? "").localeCompare(b.mergedAt ?? "") || a.number - b.number);
}

function decisionsFor(state: ProjectState, ws: WorkstreamState): DecisionRecord[] {
  return state.decisions
    .filter((d) => ws.relatedDecisionIds.includes(d.decisionId))
    .sort((a, b) => a.decisionId.localeCompare(b.decisionId));
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * A workstream that finished with a real arc behind it.
 *
 * Completion alone is not the signal — a workstream can close having changed nothing anyone needs
 * explained. What makes an episode is the shape the idea note names: problem, discovery, decision,
 * outcome. Decisions and merged pull requests are the observable proxy for that shape, so a
 * completed workstream with neither is recorded as considered-and-rejected rather than proposed.
 */
function completedWorkstreamRule(
  state: ProjectState,
  ws: WorkstreamState,
  thresholds: SuggestionThresholds,
  at: string,
): DraftSuggestion | undefined {
  if (!finished(ws)) return undefined;

  const prs = mergedPullRequestsFor(state, ws);
  const decisions = decisionsFor(state, ws);
  const substance = prs.length + decisions.length;

  const refs = [wsRef(state.projectId, ws), ...prs.map((pr) => prRef(state.projectId, pr))];
  const evidence = [ws.source, editorialRef(ws.workstreamId, at)];

  if (substance < 2) {
    return {
      entityId: ws.workstreamId,
      title: `${ws.workstreamId} — ${ws.title}`,
      whyNow: `${ws.workstreamId} finished, but with ${substance === 0 ? "no" : "only one"} decision or merged pull request behind it.`,
      whatYouWouldLearn: [],
      freshness: `Completed${ws.updatedAt ? ` ${ws.updatedAt.slice(0, 10)}` : ""}.`,
      scope: "SHORT_EXPLAINER",
      reasonCode: "NOT_WORTH_AN_EPISODE",
      score: 0,
      scoreReasons: ["A workstream that closed without a decision trail or merged work has no story arc to explain."],
      refs,
      evidence,
    };
  }

  const score = 40 + Math.min(prs.length, 4) * 6 + Math.min(decisions.length, 4) * 8;
  const scoreReasons = [
    "A completed workstream is a finished story rather than work in progress.",
    `${prs.length} merged pull request${prs.length === 1 ? "" : "s"} behind it.`,
    `${decisions.length} recorded decision${decisions.length === 1 ? "" : "s"}.`,
  ];

  return {
    entityId: ws.workstreamId,
    title: `How ${ws.title} came together`,
    whyNow: [
      `${ws.workstreamId} has finished.`,
      ws.goal ? `Its goal was: ${ws.goal}` : undefined,
      `It carries ${decisions.length} recorded decision${decisions.length === 1 ? "" : "s"} and ${prs.length} merged pull request${prs.length === 1 ? "" : "s"}, which is enough of an arc to explain rather than list.`,
    ]
      .filter(Boolean)
      .join(" "),
    whatYouWouldLearn: [
      ws.goal ? `What ${ws.workstreamId} set out to do: ${ws.goal}` : `What ${ws.workstreamId} set out to do.`,
      ...decisions.slice(0, 4).map((d) => `Why ${d.decisionId} was decided: ${d.title}`),
      ...prs.slice(0, 4).map((pr) => `What #${pr.number} changed: ${pr.title}`),
    ],
    freshness: `Completed${ws.updatedAt ? ` ${ws.updatedAt.slice(0, 10)}` : ""}, with the work still recent enough to matter.`,
    scope: substance >= 5 ? "DEEP_DIVE" : "EPISODE",
    reasonCode: "WORKSTREAM_COMPLETED",
    score,
    scoreReasons,
    refs: [...refs, ...decisions.map((d) => decisionRef(state.projectId, d))],
    evidence,
  };
}

/**
 * Several merged pull requests serving one workstream that is still running.
 *
 * The narrative exists before the workstream closes, and waiting for completion would mean the
 * explainer arrives only once the owner no longer needs it. The threshold is what keeps this from
 * firing on ordinary week-to-week merging.
 */
function pullRequestNarrativeRule(
  state: ProjectState,
  ws: WorkstreamState,
  thresholds: SuggestionThresholds,
  at: string,
): DraftSuggestion | undefined {
  if (finished(ws)) return undefined;

  const prs = mergedPullRequestsFor(state, ws);
  if (prs.length === 0) return undefined;

  const refs = [wsRef(state.projectId, ws), ...prs.map((pr) => prRef(state.projectId, pr))];
  const evidence = [ws.source, editorialRef(ws.workstreamId, at)];

  if (prs.length < thresholds.narrativePullRequests) {
    return {
      entityId: ws.workstreamId,
      title: `${ws.workstreamId} — ${ws.title}`,
      whyNow: `${ws.workstreamId} has ${prs.length} merged pull request${prs.length === 1 ? "" : "s"}, which is ordinary progress rather than a narrative.`,
      whatYouWouldLearn: [],
      freshness: `Last merge${prs.at(-1)?.mergedAt ? ` ${prs.at(-1)!.mergedAt!.slice(0, 10)}` : ""}.`,
      scope: "SHORT_EXPLAINER",
      reasonCode: "NOT_WORTH_AN_EPISODE",
      score: 0,
      scoreReasons: [
        `Below the ${thresholds.narrativePullRequests}-pull-request bar for a narrative; suggesting this would be suggesting an episode about routine work.`,
      ],
      refs,
      evidence,
    };
  }

  const score = 32 + Math.min(prs.length, 6) * 5;

  return {
    entityId: ws.workstreamId,
    title: `${ws.title}, across ${prs.length} pull requests`,
    whyNow: [
      `${prs.length} merged pull requests now serve ${ws.workstreamId}, and no single one of them explains the whole.`,
      ws.goal ? `The thread running through them: ${ws.goal}` : undefined,
    ]
      .filter(Boolean)
      .join(" "),
    whatYouWouldLearn: [
      ws.goal ? `What the work is for: ${ws.goal}` : `What ${ws.workstreamId} is for.`,
      ...prs.slice(0, 5).map((pr) => `What #${pr.number} contributed: ${pr.title}`),
      ws.nextStep ? `Where it goes next: ${ws.nextStep}` : "Where the work stands now.",
    ],
    freshness: `Still active, with the most recent merge${prs.at(-1)?.mergedAt ? ` on ${prs.at(-1)!.mergedAt!.slice(0, 10)}` : ""}.`,
    scope: prs.length >= 5 ? "DEEP_DIVE" : "EPISODE",
    reasonCode: "PR_NARRATIVE",
    score,
    scoreReasons: [
      "Several pull requests form one story that none of them tells alone.",
      `${prs.length} merged, against a bar of ${thresholds.narrativePullRequests}.`,
    ],
    refs,
    evidence,
  };
}

/**
 * A cluster of decisions on one workstream.
 *
 * Decisions are where the reasoning lives, and reasoning is the thing a digest is worst at
 * carrying. This fires whether or not the workstream has finished — the tradeoffs are explainable
 * as soon as they are made.
 */
function decisionClusterRule(
  state: ProjectState,
  ws: WorkstreamState,
  thresholds: SuggestionThresholds,
  at: string,
): DraftSuggestion | undefined {
  const decisions = decisionsFor(state, ws).filter((d) => d.status === "ACCEPTED");
  if (decisions.length < thresholds.clusterDecisions) return undefined;

  // A completed workstream already proposes its own, richer episode; a second card about the same
  // decisions would be the duplication the idea note warns about.
  if (finished(ws)) return undefined;

  const score = 30 + Math.min(decisions.length, 5) * 7;

  return {
    entityId: ws.workstreamId,
    title: `The tradeoffs behind ${ws.title}`,
    whyNow: `${decisions.length} decisions have been accepted on ${ws.workstreamId}. Each is recorded as an outcome; none of them records why the alternative lost.`,
    whatYouWouldLearn: decisions.slice(0, 5).map((d) => `${d.decisionId}: ${d.title}`),
    freshness: `Decided recently enough that the reasoning is still worth capturing.`,
    scope: decisions.length >= 4 ? "EPISODE" : "SHORT_EXPLAINER",
    reasonCode: "DECISION_CLUSTER",
    score,
    scoreReasons: [
      "Decisions carry reasoning a digest cannot.",
      `${decisions.length} accepted, against a bar of ${thresholds.clusterDecisions}.`,
    ],
    refs: [wsRef(state.projectId, ws), ...decisions.map((d) => decisionRef(state.projectId, d))],
    evidence: [ws.source, editorialRef(ws.workstreamId, at)],
  };
}

/**
 * Open decisions nobody has answered.
 *
 * Scored below the settled-story rules on purpose. An unresolved tension is genuinely worth
 * explaining — the idea note lists it as a ranking dimension — but it competes with finished
 * arcs, and a finished arc is the safer episode.
 */
function openTradeoffRule(
  state: ProjectState,
  ws: WorkstreamState,
  thresholds: SuggestionThresholds,
  at: string,
): DraftSuggestion | undefined {
  if (finished(ws)) return undefined;
  if (ws.openDecisions.length < thresholds.clusterDecisions) return undefined;

  const score = 26 + Math.min(ws.openDecisions.length, 4) * 6;

  return {
    entityId: ws.workstreamId,
    title: `What is still undecided in ${ws.title}`,
    whyNow: `${ws.openDecisions.length} decisions on ${ws.workstreamId} are open. Understanding the shape of the choice is what makes answering it possible.`,
    whatYouWouldLearn: ws.openDecisions.slice(0, 5).map((d) => `${d.key}: ${d.question}`),
    freshness: "Open now, and the episode stops being useful the moment they are answered.",
    scope: "SHORT_EXPLAINER",
    reasonCode: "OPEN_TRADEOFF",
    score,
    scoreReasons: [
      "Unresolved tradeoffs are worth explaining before they are settled, not after.",
      `${ws.openDecisions.length} open decisions.`,
      "Scored below finished arcs, which make safer episodes.",
    ],
    refs: [wsRef(state.projectId, ws)],
    evidence: [ws.source, editorialRef(ws.workstreamId, at)],
  };
}

// ---------------------------------------------------------------------------

/**
 * Every candidate the rules produced, including the rejected ones, worst-scoring last.
 *
 * Callers that want only what should be shown use `openSuggestions`. This returns everything so
 * the editorial decision itself can be inspected — the same reason the attention engine emits
 * `AUTONOMOUS_PROGRESS` items nobody displays.
 */
export function suggestTopics(input: SuggestionInput): TopicSuggestion[] {
  const { state, projectName, now } = input;
  const thresholds = input.thresholds ?? DEFAULT_SUGGESTION_THRESHOLDS;
  const at = now.toISOString();

  const drafts: DraftSuggestion[] = [];
  for (const ws of state.workstreams) {
    if (ws.status === "ABANDONED") continue;

    for (const rule of [completedWorkstreamRule, pullRequestNarrativeRule, decisionClusterRule, openTradeoffRule]) {
      const draft = rule(state, ws, thresholds, at);
      if (draft) drafts.push(draft);
    }
  }

  return drafts
    .map((draft) => ({
      id: suggestionId(state.projectId, draft.entityId, draft.reasonCode),
      projectId: state.projectId,
      projectName,
      title: draft.title,
      whyNow: draft.whyNow,
      whatYouWouldLearn: draft.whatYouWouldLearn,
      freshness: draft.freshness,
      scope: draft.scope,
      reasonCode: draft.reasonCode,
      score: draft.score,
      scoreReasons: draft.scoreReasons,
      refs: draft.refs,
      evidence: draft.evidence,
      suggestedAt: at,
    }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/**
 * The ones worth showing: above the score bar, capped, and never one the owner has settled.
 *
 * `decided` carries the ids the owner has already saved, dismissed, or made an episode from. A
 * dismissal is permanent for as long as the situation is unchanged, which is exactly what the
 * content-hashed id encodes: if the underlying story grows enough to change the id, it is a
 * different proposal and gets asked again.
 */
export function openSuggestions(
  suggestions: TopicSuggestion[],
  decided: ReadonlySet<string>,
  thresholds: SuggestionThresholds = DEFAULT_SUGGESTION_THRESHOLDS,
): TopicSuggestion[] {
  return suggestions
    .filter((s) => s.reasonCode !== "NOT_WORTH_AN_EPISODE")
    .filter((s) => worthSuggesting(s.score, thresholds))
    .filter((s) => !decided.has(s.id))
    .slice(0, thresholds.maximumOpen);
}
