/**
 * The deep-dive podcast script: "help me understand this."
 *
 * Only ever built from a topic and beats the owner has already approved — this module does not
 * decide what is worth a deep dive, it renders one that has already been chosen. See
 * `docs/ideas/topic-podcast-suggestions.md`: "Suggest freely; generate only after explicit user
 * approval." Automatic topic detection is a separate, not-yet-built concern.
 */

import type { Fact, FactPackProject } from "../briefing/fact-pack.ts";
import type { DeepDiveBeat, DeepDiveTopic, PodcastLine, PodcastScript, PodcastSegment } from "./types.ts";

function factLine(fact: Fact): PodcastLine {
  return {
    speaker: "REPORTER",
    text: fact.detail ? `${fact.text} ${fact.detail}` : fact.text,
    refs: fact.refs,
  };
}

function beatSegment(beat: DeepDiveBeat, index: number): PodcastSegment {
  const withAction = beat.facts.filter((f) => f.action);
  const lines = beat.facts.map(factLine);

  if (withAction.length > 0) {
    lines.push({
      speaker: "ANALYST",
      text: `${withAction.length} of those still ${withAction.length === 1 ? "has" : "have"} an open action attached.`,
      refs: withAction.flatMap((f) => f.refs),
    });
  }

  return { key: `beat_${index}`, title: beat.title, lines };
}

export interface DeepDiveInput {
  topic: DeepDiveTopic;
  beats: DeepDiveBeat[];
  generatedAt: string;
  ownerUserId: string;
  projects: FactPackProject[];
}

export function buildDeepDivePodcastScript(input: DeepDiveInput): PodcastScript {
  const { topic, beats } = input;

  const coldOpen: PodcastSegment = {
    key: "cold_open",
    title: "Cold open",
    lines: [
      { speaker: "REPORTER", text: `Today's deep dive: ${topic.title}.`, refs: [] },
      { speaker: "ANALYST", text: topic.whyNow, refs: [] },
    ],
  };

  const bodySegments: PodcastSegment[] =
    beats.length > 0
      ? beats.map(beatSegment)
      : [
          {
            key: "no_facts",
            title: "No grounding",
            lines: [
              { speaker: "REPORTER", text: "No approved facts were attached to this topic yet.", refs: [] },
            ],
          },
        ];

  const close: PodcastSegment = {
    key: "close",
    title: "Close",
    lines: [
      {
        speaker: "ANALYST",
        text: `That's ${topic.title} — ${beats.length} thing${beats.length === 1 ? "" : "s"} worth carrying forward from it.`,
        refs: [],
      },
    ],
  };

  return {
    kind: "DEEP_DIVE",
    title: topic.title,
    generatedAt: input.generatedAt,
    ownerUserId: input.ownerUserId,
    projects: input.projects,
    segments: [coldOpen, ...bodySegments, close],
    sourceFactIds: beats.flatMap((b) => b.facts.map((f) => f.id)),
  };
}
