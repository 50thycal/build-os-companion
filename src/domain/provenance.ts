/**
 * Provenance and source precedence.
 *
 * Every fact the Companion holds must be traceable to where it came from, and when two
 * sources disagree the winner is decided by a fixed order — never by whichever was written
 * last, and never by an LLM.
 *
 * See build-os `framework/AGENT_SESSION_CHECKPOINT.md` and DEC-009.
 */

/** Where a fact came from, in descending order of authority. */
export type SourceType =
  /** A canonical Build OS artifact committed to GitHub: workstream file, ACTIVE.md, DECISIONS.md. */
  | "BUILD_OS_ARTIFACT"
  /** GitHub's own record of a PR, review, or check run. */
  | "GITHUB_STATE"
  /** An explicit agent session checkpoint. Ephemeral when posted to an API. */
  | "SESSION_CHECKPOINT"
  /** Anything derived by a model. Never canonical. */
  | "INFERENCE";

/**
 * Precedence rank. Higher wins.
 *
 * ```text
 * canonical Build OS artifact > GitHub PR/CI state > session checkpoint > AI inference
 * ```
 */
const PRECEDENCE: Record<SourceType, number> = {
  BUILD_OS_ARTIFACT: 40,
  GITHUB_STATE: 30,
  SESSION_CHECKPOINT: 20,
  INFERENCE: 10,
};

export function precedenceOf(source: SourceType): number {
  return PRECEDENCE[source];
}

/** A pointer back to the exact thing that produced a fact. */
export interface SourceRef {
  sourceType: SourceType;
  /** Stable identifier within the source system: `pr:84`, `check:123`, `docs/workstreams/WS-004-x.md`. */
  sourceId: string;
  /** Canonical URL the owner can open. Absent only when the source genuinely has no URL. */
  sourceUrl?: string;
  /** Commit the artifact was read at, for Build OS artifacts. */
  sourceCommitSha?: string;
  /** When the source system says this happened. */
  observedAt: string;
}

/** A value together with where it came from. */
export interface Attributed<T> {
  value: T;
  source: SourceRef;
}

export interface SourceConflict<T = unknown> {
  /** Dotted path of the field that disagrees, e.g. `workstream.phase`. */
  field: string;
  winner: Attributed<T>;
  losers: Attributed<T>[];
}

export interface Resolution<T> {
  resolved: Attributed<T> | undefined;
  conflicts: SourceConflict<T>[];
}

/**
 * Resolve competing values for one field.
 *
 * Ties within the same source type are broken by `observedAt`, newest first — two readings of
 * the same source are not a conflict, they are a stale reading and a fresh one.
 *
 * A conflict is reported only when sources of *different* authority disagree on the value.
 * That distinction matters: the UI is required to surface conflicts, and a UI that cries
 * conflict every poll cycle will be ignored.
 */
export function resolveField<T>(
  field: string,
  candidates: Attributed<T>[],
  equals: (a: T, b: T) => boolean = (a, b) => a === b,
): Resolution<T> {
  const present = candidates.filter((c) => c.value !== undefined && c.value !== null);
  if (present.length === 0) return { resolved: undefined, conflicts: [] };

  const ranked = [...present].sort((a, b) => {
    const byPrecedence = precedenceOf(b.source.sourceType) - precedenceOf(a.source.sourceType);
    if (byPrecedence !== 0) return byPrecedence;
    return b.source.observedAt.localeCompare(a.source.observedAt);
  });

  const winner = ranked[0]!;
  const losers = ranked
    .slice(1)
    .filter(
      (c) =>
        !equals(c.value, winner.value) &&
        precedenceOf(c.source.sourceType) !== precedenceOf(winner.source.sourceType),
    );

  return {
    resolved: winner,
    conflicts: losers.length > 0 ? [{ field, winner, losers }] : [],
  };
}
