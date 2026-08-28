/**
 * The feed, grouped by project.
 *
 * A flat chronological list works for two repositories and stops working at ten. Once discovery
 * opens the feed to the owner's whole portfolio, "what changed?" is no longer one question — it
 * is one question per project, and an interleaved stream answers none of them: a run of six
 * cards from one busy repository buries the one card from another that actually needs somebody.
 *
 * So the top level of the feed is the portfolio, and each project carries the four facts that
 * decide whether the owner should open it — whether anything needs them, how much is in flight,
 * when it last moved, and what the most recent meaningful change was. Cards live underneath.
 *
 * This is a grouping, not a filter. Every card is in exactly one group and no card is dropped;
 * `visible`/`collapsed` only decides what a screen shows before the owner asks for the rest.
 */

import { severityRank, type Severity } from "../domain/attention.ts";
import type { StoredProject } from "../store/store.ts";
import type { ProjectState } from "../domain/state.ts";
import type { FeedCard } from "./cards.ts";

export interface ProjectGroup {
  projectId: string;
  projectName: string;
  repositoryFullName: string;
  /** Why this project is in the feed at all — the discovery rule's evidence, verbatim. */
  discoveryEvidence?: string;
  /** True when the project's Build OS artifacts were found and parsed. */
  buildOs: boolean;
  /** The highest severity anything in this project is asking for. `NONE` means nothing is. */
  severity: Severity;
  /** How many distinct things need the owner here. */
  needsYouCount: number;
  activeWorkstreamCount: number;
  openPullRequestCount: number;
  /** The most recent event across the group. What "last moved" means. */
  lastChangeAt?: string;
  /** The single sentence a project row should carry: its most significant recent change. */
  lastChange?: string;
  /** Cards a screen shows immediately, already ranked. */
  visible: FeedCard[];
  /** The rest, in rank order. Never discarded — a group is always its whole self. */
  collapsed: FeedCard[];
  /** Set when the last sync of this project failed; what is shown is the last good picture. */
  staleSince?: string;
}

export interface PortfolioInput {
  projects: { project: StoredProject; state: ProjectState }[];
  cards: FeedCard[];
  /** How many cards each project shows before the rest collapse. */
  visiblePerProject?: number;
}

const DEFAULT_VISIBLE = 3;

/**
 * Group ranked cards by project and order the groups.
 *
 * Ordering repeats the ranking rule one level up: what needs the owner first, then what moved
 * most recently. A project with nothing outstanding never outranks one that is asking for
 * something, however busy it has been — which is the same promise the card ranking makes, and
 * it has to hold at both levels or the top of the page contradicts the top of each group.
 */
export function buildPortfolio(input: PortfolioInput): ProjectGroup[] {
  const visiblePerProject = input.visiblePerProject ?? DEFAULT_VISIBLE;
  const byProject = new Map<string, FeedCard[]>();
  for (const card of input.cards) {
    byProject.set(card.projectId, [...(byProject.get(card.projectId) ?? []), card]);
  }

  const groups = input.projects.map(({ project, state }) => {
    const cards = byProject.get(project.id) ?? [];
    const attention = cards.filter((card) => card.needsYou !== "Nothing.");
    const severity = cards.reduce<Severity>(
      (worst, card) => (severityRank(card.severity) > severityRank(worst) ? card.severity : worst),
      "NONE",
    );

    // The most significant recent change, not merely the newest: the cards are already ranked by
    // exactly that blend, so the first one is the answer.
    const headline = cards[0];
    const lastChangeAt = cards.reduce<string | undefined>(
      (latest, card) => (latest === undefined || card.occurredAt > latest ? card.occurredAt : latest),
      undefined,
    );

    return {
      projectId: project.id,
      projectName: project.displayName ?? project.repositoryFullName,
      repositoryFullName: project.repositoryFullName,
      discoveryEvidence: project.discoveryEvidence,
      buildOs: project.buildOsDetected && state.workstreams.length > 0,
      severity,
      needsYouCount: attention.length,
      activeWorkstreamCount: state.workstreams.filter(
        (ws) => ws.status !== "COMPLETE" && ws.status !== "ABANDONED" && ws.phase !== "COMPLETE",
      ).length,
      openPullRequestCount: state.pullRequests.filter(
        (pr) => pr.lifecycle === "OPEN" || pr.lifecycle === "DRAFT",
      ).length,
      lastChangeAt,
      lastChange: headline?.whatChanged,
      visible: cards.slice(0, visiblePerProject),
      collapsed: cards.slice(visiblePerProject),
      staleSince: project.staleSince,
    } satisfies ProjectGroup;
  });

  return groups.sort((a, b) => {
    const bySeverity = severityRank(b.severity) - severityRank(a.severity);
    if (bySeverity !== 0) return bySeverity;
    const byRecency = (b.lastChangeAt ?? "").localeCompare(a.lastChangeAt ?? "");
    if (byRecency !== 0) return byRecency;
    return a.projectName.localeCompare(b.projectName);
  });
}
