/**
 * The briefing fact pack.
 *
 * A structured, fully-derived account of where every followed project stands, assembled from
 * the ledger, the stored projections and the attention engine — and from nothing else.
 *
 * Every fact carries `refs` back to the events and entities that produced it. That is the
 * load-bearing property. This structure exists to be rendered into prose later, and the rule
 * for that renderer is that it may only restate what is here: it does not get to reach for
 * project state itself, and it does not get to assert anything a `FactRef` cannot account for.
 * A fact with no references is a sentence nobody can check, which in a briefing the owner is
 * meant to act on is worse than no sentence at all.
 *
 * A fully deterministic rendering is the first version, and is arguably the right permanent
 * one — see `render.ts`.
 */

import type { Severity } from "../domain/attention.ts";
import { severityRank } from "../domain/attention.ts";
import { describeCi, describePhase, describeReview } from "../domain/describe.ts";
import type { ProjectState, PullRequestState, SessionState, WorkstreamState } from "../domain/state.ts";
import type { SqliteEventLedger } from "../ledger/sqlite-ledger.ts";
import type { CompanionStore, StoredProject, TrackedAttentionItem } from "../store/store.ts";
import { buildSinceLastChecked, type ChangeEntry, type SinceLastChecked } from "./since.ts";

export const FACT_SECTIONS = [
  "WHAT_CHANGED",
  "WHAT_NEEDS_ME",
  "WHAT_FINISHED",
  "WHAT_IS_HAPPENING",
  "WHAT_IS_BLOCKED",
  "WHAT_NEXT",
] as const;

export type FactSectionKey = (typeof FACT_SECTIONS)[number];

export const SECTION_TITLES: Record<FactSectionKey, string> = {
  WHAT_CHANGED: "What changed",
  WHAT_NEEDS_ME: "What needs me",
  WHAT_FINISHED: "What finished",
  WHAT_IS_HAPPENING: "What agents and workstreams are doing",
  WHAT_IS_BLOCKED: "What is blocked",
  WHAT_NEXT: "What to look at next",
};

/** What a section says when it has nothing in it. Silence and emptiness are different. */
export const SECTION_EMPTY: Record<FactSectionKey, string> = {
  WHAT_CHANGED: "Nothing changed in any followed project.",
  WHAT_NEEDS_ME: "Nothing needs you. No rule in the attention engine matched.",
  WHAT_FINISHED: "Nothing finished.",
  WHAT_IS_HAPPENING: "No workstream is active and no agent session is running.",
  WHAT_IS_BLOCKED: "Nothing is blocked.",
  WHAT_NEXT: "Nothing is waiting on a next step.",
};

export type FactRefKind =
  | "EVENT"
  | "PULL_REQUEST"
  | "WORKSTREAM"
  | "SESSION"
  | "DECISION"
  | "ATTENTION"
  | "PROJECT";

/** A pointer to the normalized thing a fact rests on. */
export interface FactRef {
  kind: FactRefKind;
  id: string;
  projectId: string;
  url?: string;
}

export interface Fact {
  /** Stable within a pack, so a renderer can address a fact without relying on position. */
  id: string;
  projectId: string;
  projectName: string;
  /** One deterministic sentence. Never model-generated. */
  text: string;
  /** Supporting sentence, when the fact needs one. */
  detail?: string;
  severity?: Severity;
  /** The recommended action, where the attention engine produced one. */
  action?: string;
  refs: FactRef[];
}

export interface FactSection {
  key: FactSectionKey;
  title: string;
  facts: Fact[];
  /** Rendered instead of the facts when there are none. */
  emptyText: string;
}

export interface FactPackProject {
  projectId: string;
  projectName: string;
  repositoryFullName: string;
  lastSyncedAt?: string;
  /** Set when the last sync failed. State shown is the last good one. */
  staleSince?: string;
  syncError?: string;
}

export interface FactPack {
  generatedAt: string;
  ownerUserId: string;
  projects: FactPackProject[];
  /** The sequence window this pack covers, and what marking it read would record. */
  fromSequence: number;
  toSequence: number;
  isFirstLook: boolean;
  sections: FactSection[];
  /** The underlying change set, for a renderer that wants the raw grouping. */
  since: SinceLastChecked;
}

let counter = 0;
function factId(section: FactSectionKey, key: string): string {
  // Deterministic within a pack: same section and entity, same id, however often it is built.
  counter += 1;
  return `${section.toLowerCase()}:${key}`.replace(/[^a-z0-9:_-]+/gi, "-");
}

const prRef = (projectId: string, pr: PullRequestState): FactRef => ({
  kind: "PULL_REQUEST",
  id: `pr:${pr.number}`,
  projectId,
  url: pr.sourceUrl,
});

const wsRef = (projectId: string, ws: WorkstreamState): FactRef => ({
  kind: "WORKSTREAM",
  id: ws.workstreamId,
  projectId,
  url: ws.source.sourceUrl,
});

function entryRefs(entry: ChangeEntry): FactRef[] {
  return [
    { kind: entry.entityType, id: entry.entityId, projectId: entry.projectId, url: entry.sourceUrl },
    ...entry.eventIds.map((id) => ({ kind: "EVENT" as const, id, projectId: entry.projectId })),
  ];
}

export interface FactPackInput {
  store: CompanionStore;
  ledger: SqliteEventLedger;
  ownerUserId: string;
  now: Date;
  projectId?: string;
}

export function buildFactPack(input: FactPackInput): FactPack {
  const { store, ledger, ownerUserId, now } = input;
  counter = 0;

  const followed = store
    .listProjects()
    .filter((p) => !input.projectId || p.id === input.projectId);
  const nameOf = (p: StoredProject) => p.displayName ?? p.repositoryFullName;

  const since = buildSinceLastChecked({ store, ledger, ownerUserId, now, projectId: input.projectId });
  const states = new Map<string, ProjectState>(followed.map((p) => [p.id, store.loadProjectState(p.id)]));
  const nameById = new Map(followed.map((p) => [p.id, nameOf(p)]));
  const projectName = (id: string) => nameById.get(id) ?? id;

  const attention = store
    .openAttention(input.projectId)
    .filter((a) => nameById.has(a.projectId));

  return {
    generatedAt: now.toISOString(),
    ownerUserId,
    projects: followed.map((p) => ({
      projectId: p.id,
      projectName: nameOf(p),
      repositoryFullName: p.repositoryFullName,
      lastSyncedAt: p.lastSyncedAt,
      staleSince: p.staleSince,
      syncError: p.lastError,
    })),
    fromSequence: since.fromSequence,
    toSequence: since.toSequence,
    isFirstLook: since.isFirstLook,
    since,
    sections: [
      whatChanged(since, projectName),
      whatNeedsMe(attention, projectName),
      whatFinished(since, projectName),
      whatIsHappening(states, projectName),
      whatIsBlocked(states, attention, projectName),
      whatNext(attention, states, projectName),
    ],
  };
}

// ---------------------------------------------------------------------------

function section(key: FactSectionKey, facts: Fact[]): FactSection {
  return { key, title: SECTION_TITLES[key], facts, emptyText: SECTION_EMPTY[key] };
}

function whatChanged(since: SinceLastChecked, projectName: (id: string) => string): FactSection {
  // "Needs you" and "finished" have sections of their own; repeating them here would pad the
  // briefing without adding a fact.
  const facts = since.groups
    .filter((g) => g.category !== "NEEDS_YOU" && g.category !== "FINISHED")
    .flatMap((group) =>
      group.entries.map((entry) => ({
        id: factId("WHAT_CHANGED", `${entry.projectId}-${entry.entityId}`),
        projectId: entry.projectId,
        projectName: projectName(entry.projectId),
        text: `${entry.entityLabel}: ${entry.headline}`,
        detail: entry.detail,
        severity: entry.severity,
        refs: entryRefs(entry),
      })),
    );

  return section("WHAT_CHANGED", facts);
}

function whatNeedsMe(attention: TrackedAttentionItem[], projectName: (id: string) => string): FactSection {
  const facts = attention.map((item) => ({
    id: factId("WHAT_NEEDS_ME", `${item.projectId}-${item.entityId}-${item.reasonCode}`),
    projectId: item.projectId,
    projectName: projectName(item.projectId),
    text: item.reasonText,
    detail: `Waiting since ${item.firstSeenAt.slice(0, 10)}. Classified ${item.reasonCode} from ${
      item.evidence.length
    } source${item.evidence.length === 1 ? "" : "s"}.`,
    severity: item.severity,
    action: item.recommendedAction,
    refs: [
      { kind: "ATTENTION" as const, id: item.id, projectId: item.projectId },
      {
        kind: item.entityType,
        id: item.entityId,
        projectId: item.projectId,
        url: item.evidence[0]?.sourceUrl,
      },
    ],
  }));

  return section("WHAT_NEEDS_ME", facts);
}

function whatFinished(since: SinceLastChecked, projectName: (id: string) => string): FactSection {
  const finished = since.groups.find((g) => g.category === "FINISHED");
  const facts = (finished?.entries ?? []).map((entry) => ({
    id: factId("WHAT_FINISHED", `${entry.projectId}-${entry.entityId}`),
    projectId: entry.projectId,
    projectName: projectName(entry.projectId),
    text: entry.headline,
    detail: entry.detail,
    refs: entryRefs(entry),
  }));

  return section("WHAT_FINISHED", facts);
}

function whatIsHappening(
  states: Map<string, ProjectState>,
  projectName: (id: string) => string,
): FactSection {
  const facts: Fact[] = [];

  for (const [projectId, state] of states) {
    for (const ws of state.workstreams) {
      if (ws.status === "COMPLETE" || ws.status === "ABANDONED" || ws.phase === "COMPLETE") continue;

      const sessions = state.sessions.filter(
        (s) => s.workstreamId === ws.workstreamId && (s.status === "ACTIVE" || s.status === "WAITING"),
      );
      const prs = ws.relatedPrNumbers
        .map((n) => state.pullRequests.find((pr) => pr.number === n))
        .filter((pr): pr is PullRequestState => pr !== undefined);
      const openPrs = prs.filter((pr) => pr.lifecycle === "OPEN" || pr.lifecycle === "DRAFT");

      facts.push({
        id: factId("WHAT_IS_HAPPENING", `${projectId}-${ws.workstreamId}`),
        projectId,
        projectName: projectName(projectId),
        text: `${ws.workstreamId} — ${ws.title} is in ${describePhase(ws.phase)}${
          ws.status ? `, ${ws.status.toLowerCase()}` : ""
        }.`,
        detail: [
          ws.nextStep ? `Next: ${ws.nextStep}` : undefined,
          sessions.length > 0
            ? `${sessions.map((s) => s.agentName ?? s.agent).join(", ")} working on it.`
            : undefined,
          openPrs.length > 0 ? `Open PR${openPrs.length === 1 ? "" : "s"}: ${openPrs.map((p) => `#${p.number}`).join(", ")}.` : undefined,
        ]
          .filter(Boolean)
          .join(" "),
        refs: [
          wsRef(projectId, ws),
          ...prs.map((pr) => prRef(projectId, pr)),
          ...sessions.map((s) => ({ kind: "SESSION" as const, id: s.sessionId, projectId })),
        ],
      });
    }

    // A session with no workstream is still work happening, and losing it would misreport the
    // project as idle.
    for (const s of state.sessions) {
      if (s.workstreamId || (s.status !== "ACTIVE" && s.status !== "WAITING")) continue;
      facts.push({
        id: factId("WHAT_IS_HAPPENING", `${projectId}-${s.sessionId}`),
        projectId,
        projectName: projectName(projectId),
        text: `${s.agentName ?? s.agent} is ${s.status.toLowerCase()}: ${s.objective}`,
        detail: s.nextStep ? `Next: ${s.nextStep}` : undefined,
        refs: [{ kind: "SESSION", id: s.sessionId, projectId }],
      });
    }
  }

  return section("WHAT_IS_HAPPENING", facts);
}

function whatIsBlocked(
  states: Map<string, ProjectState>,
  attention: TrackedAttentionItem[],
  projectName: (id: string) => string,
): FactSection {
  const facts: Fact[] = [];

  for (const [projectId, state] of states) {
    for (const ws of state.workstreams) {
      if (ws.status !== "BLOCKED") continue;
      facts.push({
        id: factId("WHAT_IS_BLOCKED", `${projectId}-${ws.workstreamId}`),
        projectId,
        projectName: projectName(projectId),
        text: `${ws.workstreamId} is blocked: ${ws.blocker ?? "no reason recorded in the workstream file"}`,
        severity: attention.find((a) => a.entityId === ws.workstreamId)?.severity,
        refs: [wsRef(projectId, ws)],
      });
    }

    for (const s of state.sessions) {
      if (s.status !== "BLOCKED") continue;
      const ownerBlocker = s.blockers.find((b) => b.needsOwner);
      facts.push({
        id: factId("WHAT_IS_BLOCKED", `${projectId}-${s.sessionId}`),
        projectId,
        projectName: projectName(projectId),
        text: `${s.agentName ?? s.agent} is blocked: ${s.blockers[0]?.description ?? "no reason recorded"}`,
        detail: ownerBlocker ? "Waiting on you." : "Not waiting on you.",
        refs: [{ kind: "SESSION", id: s.sessionId, projectId }],
      });
    }

    for (const pr of state.pullRequests) {
      if (pr.lifecycle === "MERGED" || pr.lifecycle === "CLOSED") continue;
      const conflicted = pr.mergeability === "CONFLICTED";
      const failing = pr.ciState === "FAILED";
      if (!conflicted && !failing) continue;

      facts.push({
        id: factId("WHAT_IS_BLOCKED", `${projectId}-pr-${pr.number}`),
        projectId,
        projectName: projectName(projectId),
        text: `PR #${pr.number} cannot land: ${[
          conflicted ? `it conflicts with ${pr.baseBranch}` : undefined,
          failing ? "its checks are failing" : undefined,
        ]
          .filter(Boolean)
          .join(" and ")}.`,
        detail: `${describeCi(pr.ciState)}, ${describeReview(pr.reviewState)}.`,
        severity: attention.find((a) => a.entityId === `pr:${pr.number}`)?.severity,
        refs: [prRef(projectId, pr)],
      });
    }
  }

  return section("WHAT_IS_BLOCKED", facts);
}

/**
 * What to do next.
 *
 * Ordered by the attention engine's severity, then by whatever the workstream files say their
 * own next step is. Nothing here is invented: every line is either a `recommendedAction` a rule
 * produced, or a `Next Step` the owner's own artifact already carries.
 */
function whatNext(
  attention: TrackedAttentionItem[],
  states: Map<string, ProjectState>,
  projectName: (id: string) => string,
): FactSection {
  const facts: Fact[] = attention
    .slice()
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
    .slice(0, 5)
    .map((item) => ({
      id: factId("WHAT_NEXT", `${item.projectId}-${item.entityId}`),
      projectId: item.projectId,
      projectName: projectName(item.projectId),
      text: item.recommendedAction,
      detail: item.reasonText,
      severity: item.severity,
      refs: [
        { kind: "ATTENTION" as const, id: item.id, projectId: item.projectId },
        { kind: item.entityType, id: item.entityId, projectId: item.projectId },
      ],
    }));

  if (facts.length === 0) {
    for (const [projectId, state] of states) {
      for (const ws of state.workstreams) {
        if (!ws.nextStep || ws.status === "COMPLETE" || ws.status === "ABANDONED") continue;
        facts.push({
          id: factId("WHAT_NEXT", `${projectId}-${ws.workstreamId}`),
          projectId,
          projectName: projectName(projectId),
          text: ws.nextStep,
          detail: `${ws.workstreamId} — ${ws.title}`,
          refs: [wsRef(projectId, ws)],
        });
      }
    }
  }

  return section("WHAT_NEXT", facts);
}
