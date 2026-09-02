/**
 * Podcast scripts: text-only, two-host dialogue rendered from a fact pack.
 *
 * WS-006 draws the pipeline as `fact pack -> written briefing -> outline -> script -> TTS`. This
 * module is the "outline -> script" step for two shapes of episode:
 *
 * - digest: what changed, built straight from a `FactPack` — the same grounding `render.ts` uses
 *   for the written briefing.
 * - deep dive: help me understand this, built from a topic the owner has already approved and
 *   the specific facts that back it (see `docs/ideas/topic-podcast-suggestions.md`).
 *
 * TTS and topic *suggestion* (deciding what deserves a deep dive) are both out of scope here —
 * the former per WS-006's own non-goals, the latter per the idea note's approval boundary:
 * suggest freely, generate only once the owner has approved a specific topic.
 *
 * Generation stays deterministic and template-based, the same discipline `briefing/render.ts`
 * documents for prose: a script may only restate what a `Fact` already carries. The Analyst role
 * is real work, not invented commentary — its lines are derived from fields already on the fact
 * (severity, action, counts), never a new claim.
 */

import type { Fact, FactPackProject, FactRef } from "../briefing/fact-pack.ts";

export type PodcastKind = "DIGEST" | "DEEP_DIVE";

export type PodcastSpeaker = "REPORTER" | "ANALYST";

export interface PodcastLine {
  speaker: PodcastSpeaker;
  text: string;
  /** Empty only for framing lines (cold open, sign-off) that assert nothing about a project. */
  refs: FactRef[];
}

export interface PodcastSegment {
  key: string;
  title: string;
  lines: PodcastLine[];
}

export interface PodcastScript {
  kind: PodcastKind;
  title: string;
  generatedAt: string;
  ownerUserId: string;
  projects: FactPackProject[];
  segments: PodcastSegment[];
  /** Every fact id this script drew a line from, so it can be checked against its source pack. */
  sourceFactIds: string[];
}

/** One beat of a deep dive: a titled block backed by specific, already-grounded facts. */
export interface DeepDiveBeat {
  title: string;
  facts: Fact[];
}

export interface DeepDiveTopic {
  title: string;
  /** Why this topic, now — the "why now" from the approved suggestion card. */
  whyNow: string;
}
