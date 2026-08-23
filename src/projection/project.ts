/**
 * State projection.
 *
 * Current state is rebuilt from the ledger rather than mutated in place. That is what makes the
 * acceptance property "workstream and PR state can be reconstructed" true rather than aspirational,
 * and it is why a corrected normalizer fixes history instead of only the future.
 */

import type { CompanionEvent } from "../domain/events.ts";
import type {
  DecisionRecord,
  IntegrityWarning,
  ProjectState,
  PullRequestState,
  SessionState,
  WorkstreamState,
} from "../domain/state.ts";
import type { SourceConflict } from "../domain/provenance.ts";

interface SnapshotCarrier {
  observedAt?: unknown;
  pr?: unknown;
}

function snapshotFrom(event: CompanionEvent): { observedAt: string; pr: PullRequestState } | undefined {
  const raw = event.raw as SnapshotCarrier | undefined;
  if (!raw || typeof raw.observedAt !== "string" || typeof raw.pr !== "object" || raw.pr === null) {
    return undefined;
  }
  return { observedAt: raw.observedAt, pr: raw.pr as PullRequestState };
}

/**
 * Rebuild pull-request state from the event ledger.
 *
 * Recency is decided by when the source was *observed*, not by `occurredAt`. A check run that
 * completed at 09:00 and a PR update at 09:05 can arrive in the same poll; both carry the same
 * snapshot, and using `occurredAt` would let the older-timestamped one win at random.
 */
export function projectPullRequests(events: CompanionEvent[]): PullRequestState[] {
  const latest = new Map<number, { observedAt: string; sequence: number; pr: PullRequestState }>();

  events.forEach((event, sequence) => {
    if (event.pullRequestNumber === undefined) return;
    const snapshot = snapshotFrom(event);
    if (!snapshot) return;

    const existing = latest.get(event.pullRequestNumber);
    const isNewer =
      !existing ||
      snapshot.observedAt > existing.observedAt ||
      (snapshot.observedAt === existing.observedAt && sequence > existing.sequence);

    if (isNewer) {
      latest.set(event.pullRequestNumber, { observedAt: snapshot.observedAt, sequence, pr: snapshot.pr });
    }
  });

  return [...latest.values()]
    .map((entry) => entry.pr)
    .sort((a, b) => a.number - b.number);
}

/**
 * Link workstreams and pull requests, both ways, without flattening either side.
 *
 * One workstream may span several PRs and one PR may serve several workstreams; the plan calls
 * out both. A schema that assumes otherwise has to be rebuilt the first time real Build OS work
 * arrives, so the linkage is many-to-many from the start.
 */
export function linkWorkstreamsToPullRequests(
  workstreams: WorkstreamState[],
  pullRequests: PullRequestState[],
): PullRequestState[] {
  const byPr = new Map<number, Set<string>>();

  for (const ws of workstreams) {
    for (const prNumber of ws.relatedPrNumbers) {
      const set = byPr.get(prNumber) ?? new Set<string>();
      set.add(ws.workstreamId);
      byPr.set(prNumber, set);
    }
  }

  return pullRequests.map((pr) => ({
    ...pr,
    workstreamIds: [...(byPr.get(pr.number) ?? [])].sort(),
  }));
}

export interface ProjectStateInput {
  projectId: string;
  events: CompanionEvent[];
  workstreams?: WorkstreamState[];
  sessions?: SessionState[];
  decisions?: DecisionRecord[];
  integrityWarnings?: IntegrityWarning[];
  conflicts?: SourceConflict[];
}

export function buildProjectState(input: ProjectStateInput): ProjectState {
  const events = input.events.filter((e) => e.projectId === input.projectId);
  const workstreams = input.workstreams ?? [];
  const pullRequests = linkWorkstreamsToPullRequests(workstreams, projectPullRequests(events));

  return {
    projectId: input.projectId,
    pullRequests,
    workstreams,
    sessions: input.sessions ?? [],
    decisions: input.decisions ?? [],
    integrityWarnings: input.integrityWarnings ?? [],
    conflicts: input.conflicts ?? [],
  };
}

/** Index helpers the attention engine and feed both need. */
export function indexBy<T, K>(items: T[], key: (item: T) => K): Map<K, T> {
  return new Map(items.map((item) => [key(item), item]));
}
