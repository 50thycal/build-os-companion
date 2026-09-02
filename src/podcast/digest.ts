/**
 * The digest podcast script: "what changed", read straight from a `FactPack`.
 *
 * Segment order follows the fact pack's own sections, with one deliberate reordering drawn from
 * WS-006's mental model: "what needs me" always closes the episode, even when the answer is
 * "nothing" — the same question every written briefing ends on.
 */

import type { Fact, FactPack, FactSection } from "../briefing/fact-pack.ts";
import type { PodcastLine, PodcastScript, PodcastSegment } from "./types.ts";

function factLine(fact: Fact): PodcastLine {
  return {
    speaker: "REPORTER",
    text: fact.detail ? `${fact.text} ${fact.detail}` : fact.text,
    refs: fact.refs,
  };
}

/**
 * The Analyst's one line per section: a synthesis, never a new claim. Everything it says is
 * derived from fields already present on the section's own facts — counts, severities, whether
 * an action exists — so it can never assert something the Reporter's lines did not already say.
 */
function analystSynthesis(section: FactSection): PodcastLine {
  const flagged = section.facts.filter((f) => f.severity && f.severity !== "NONE").length;
  const withAction = section.facts.filter((f) => f.action).length;

  const text = [
    `That's ${section.facts.length} item${section.facts.length === 1 ? "" : "s"} in ${section.title.toLowerCase()}`,
    flagged > 0 ? `, ${flagged} of them flagged` : "",
    withAction > 0 ? `, ${withAction} with a suggested action` : "",
    ".",
  ].join("");

  return { speaker: "ANALYST", text, refs: section.facts.flatMap((f) => f.refs) };
}

function sectionSegment(section: FactSection): PodcastSegment | undefined {
  if (section.facts.length === 0) return undefined;
  return {
    key: section.key,
    title: section.title,
    lines: [...section.facts.map(factLine), analystSynthesis(section)],
  };
}

function needsMeSegment(section: FactSection): PodcastSegment {
  return (
    sectionSegment(section) ?? {
      key: section.key,
      title: section.title,
      lines: [{ speaker: "REPORTER", text: section.emptyText, refs: [] }],
    }
  );
}

export function buildDigestPodcastScript(pack: FactPack): PodcastScript {
  const projectNames = pack.projects.map((p) => p.projectName).join(", ") || "your projects";

  const coldOpen: PodcastSegment = {
    key: "cold_open",
    title: "Cold open",
    lines: [
      {
        speaker: "REPORTER",
        text: pack.isFirstLook
          ? `First look at ${projectNames}. Everything here is existing state, not news.`
          : `Here's what happened across ${projectNames} since you last checked.`,
        refs: [],
      },
    ],
  };

  const needsMe = pack.sections.find((s) => s.key === "WHAT_NEEDS_ME")!;
  const rest = pack.sections.filter((s) => s.key !== "WHAT_NEEDS_ME");
  const bodySegments = rest.map(sectionSegment).filter((s): s is PodcastSegment => s !== undefined);

  return {
    kind: "DIGEST",
    title: pack.isFirstLook ? "First look" : "Since you last checked",
    generatedAt: pack.generatedAt,
    ownerUserId: pack.ownerUserId,
    projects: pack.projects,
    segments: [coldOpen, ...bodySegments, needsMeSegment(needsMe)],
    sourceFactIds: pack.sections.flatMap((s) => s.facts.map((f) => f.id)),
  };
}
