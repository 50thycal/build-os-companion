/**
 * Podcast topic suggestions.
 *
 * The editorial layer over the fact pack: what, out of everything that has happened, is worth
 * understanding in depth rather than merely being told about. `docs/ideas/topic-podcast-
 * suggestions.md` is the idea this implements, and its central rule is the one this model exists
 * to make structural — **suggest freely; generate only after explicit approval**. A suggestion is
 * a proposal and nothing more. Nothing here starts a generation job.
 *
 * The design borrows deliberately from `attention.ts`, because the failure mode is the same one.
 * An attention list that surfaces healthy progress trains the owner to ignore it; a suggestion
 * list that proposes an episode about every merged pull request trains them to ignore that too.
 * So, as with attention:
 *
 * - every suggestion carries a reason code and a sentence, never an opaque number;
 * - the score is explained by `scoreReasons` rather than asserted;
 * - candidates that were considered and rejected are *recorded* as `NOT_WORTH_AN_EPISODE` rather
 *   than silently dropped, so the editorial judgment can be inspected and argued with.
 *
 * The value is selectivity. A large diff is not automatically a good episode, and a small change
 * that resolved a subtle failure can be.
 */

import type { FactRef } from "../briefing/fact-pack.ts";
import type { SourceRef } from "./provenance.ts";

export const SUGGESTION_REASON_CODES = [
  /** A workstream finished with decisions and pull requests behind it — a complete arc. */
  "WORKSTREAM_COMPLETED",
  /** Several merged pull requests serve one workstream: the story of how it came together. */
  "PR_NARRATIVE",
  /** Several decisions landed on one workstream: the tradeoffs behind what was built. */
  "DECISION_CLUSTER",
  /** Open decisions nobody has answered: the tension itself is the thing worth explaining. */
  "OPEN_TRADEOFF",
  /**
   * Explicit rejection: a candidate was considered and judged not to earn an episode. Scored
   * below the threshold and never stored, but computed so the editorial call is inspectable.
   */
  "NOT_WORTH_AN_EPISODE",
] as const;

export type SuggestionReasonCode = (typeof SUGGESTION_REASON_CODES)[number];

/**
 * How much episode the topic deserves.
 *
 * From the idea note's card shape. It is a proposal about depth, not a duration promise: the
 * script generator decides length from the facts it is given, and nothing downstream reads this
 * as a constraint.
 */
export const SUGGESTION_SCOPES = ["SHORT_EXPLAINER", "EPISODE", "DEEP_DIVE"] as const;

export type SuggestionScope = (typeof SUGGESTION_SCOPES)[number];

export const SCOPE_LABELS: Record<SuggestionScope, string> = {
  SHORT_EXPLAINER: "short explainer",
  EPISODE: "episode",
  DEEP_DIVE: "deep dive",
};

/**
 * The bar a candidate has to clear to be shown at all.
 *
 * Configuration rather than a constant, for the same reason the attention thresholds are: nothing
 * has calibrated this against real use yet, and the whole value of the surface rests on it being
 * quiet when it should be.
 */
export interface SuggestionThresholds {
  /** Below this score a candidate is recorded as considered-and-rejected, never shown. */
  minimumScore: number;
  /** How many suggestions may surface at once. Editorial selectivity, made literal. */
  maximumOpen: number;
  /** How many related pull requests make a narrative rather than an ordinary week's work. */
  narrativePullRequests: number;
  /** How many decisions make a cluster worth explaining. */
  clusterDecisions: number;
}

export const DEFAULT_SUGGESTION_THRESHOLDS: SuggestionThresholds = {
  minimumScore: 30,
  maximumOpen: 3,
  narrativePullRequests: 3,
  clusterDecisions: 2,
};

export function worthSuggesting(score: number, thresholds: SuggestionThresholds): boolean {
  return score >= thresholds.minimumScore;
}

export interface TopicSuggestion {
  /**
   * Deterministic: the same situation yields the same id however often it is recomputed.
   *
   * This is what makes a dismissal stick. Suggestions are not stored when they are generated —
   * only the owner's decision about one is — so the id is the whole of the join between "what the
   * engine proposes today" and "what the owner already said no to."
   */
  id: string;
  projectId: string;
  projectName: string;
  /** Human-oriented, not a pull request headline. This becomes the episode title verbatim. */
  title: string;
  /** One to three sentences. Handed to the script generator as the approved `whyNow`. */
  whyNow: string;
  /** The conceptual beats — what the owner would come away understanding. */
  whatYouWouldLearn: string[];
  /** Why this is timely, in the owner's terms rather than a timestamp. */
  freshness: string;
  scope: SuggestionScope;
  reasonCode: SuggestionReasonCode;
  /** Ranked against the other candidates. Never shown without `scoreReasons`. */
  score: number;
  /** What earned the score, one clause per contribution. An unexplained number is not allowed. */
  scoreReasons: string[];
  /**
   * Inward, at Companion's own entities: what an approved episode would be grounded in. This is
   * the provenance the generator receives, so the script can only draw on what was proposed.
   */
  refs: FactRef[];
  /**
   * Outward, at the sources the proposal rests on. The editorial judgment itself is `INFERENCE`;
   * the artifacts it read are not.
   */
  evidence: SourceRef[];
  suggestedAt: string;
}

/** What the owner did about a suggestion. A row exists only once they have actually decided. */
export const SUGGESTION_DECISIONS = ["SAVED", "DISMISSED", "EPISODE_CREATED"] as const;

export type SuggestionDecision = (typeof SUGGESTION_DECISIONS)[number];

/**
 * A decision the owner made about a proposal, holding the proposal exactly as it stood.
 *
 * The stored copy is the point. The idea note requires that approval preserve the exact topic
 * proposal and its provenance, so that what eventually gets generated is what the owner said yes
 * to — not a freshly recomputed topic that has drifted since, wearing the same id.
 */
export interface StoredSuggestionDecision {
  suggestionId: string;
  projectId: string;
  decision: SuggestionDecision;
  title: string;
  whyNow: string;
  refs: FactRef[];
  decidedAt: string;
}
