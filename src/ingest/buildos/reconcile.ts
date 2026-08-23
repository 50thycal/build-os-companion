/**
 * Reconcile the board against the workstream files.
 *
 * Both are canonical Build OS artifacts, so precedence cannot separate them. The parse contract
 * decides instead: prefer the individual workstream file for detail, and report the mismatch as
 * an integrity warning addressed to the project's owner.
 *
 * Surfacing beats merging. A silently reconciled contradiction is a contradiction the owner
 * never gets to fix.
 */

import type {
  IntegrityWarning,
  WorkstreamState,
} from "../../domain/state.ts";
import type { SourceConflict, SourceRef } from "../../domain/provenance.ts";
import { parseActiveBoard, parseWorkstreamFile, parseWorkstreamId } from "./parse.ts";
import type { ActiveBoardRow } from "./parse.ts";

export interface WorkstreamFileInput {
  /** Repository-relative path, e.g. `docs/workstreams/WS-004-thing.md`. */
  path: string;
  markdown: string;
  commitSha?: string;
  htmlUrl?: string;
}

export interface BuildOsSnapshot {
  activeBoardPath: string;
  activeBoardMarkdown: string;
  activeBoardCommitSha?: string;
  activeBoardHtmlUrl?: string;
  workstreamFiles: WorkstreamFileInput[];
  observedAt: string;
}

export interface ReconciledWorkstreams {
  workstreams: WorkstreamState[];
  warnings: IntegrityWarning[];
  conflicts: SourceConflict[];
}

function artifactSource(path: string, snapshot: BuildOsSnapshot, url?: string, sha?: string): SourceRef {
  return {
    sourceType: "BUILD_OS_ARTIFACT",
    sourceId: path,
    sourceUrl: url,
    sourceCommitSha: sha,
    observedAt: snapshot.observedAt,
  };
}

/** Phases at which a workstream legitimately leaves the active board. */
const TERMINAL_PHASES = new Set(["COMPLETE"]);
const TERMINAL_STATUSES = new Set(["COMPLETE", "ABANDONED"]);

export function reconcileBuildOsState(
  projectId: string,
  snapshot: BuildOsSnapshot,
): ReconciledWorkstreams {
  const board = parseActiveBoard(snapshot.activeBoardMarkdown);
  const boardSource = artifactSource(
    snapshot.activeBoardPath,
    snapshot,
    snapshot.activeBoardHtmlUrl,
    snapshot.activeBoardCommitSha,
  );

  const boardRows = new Map<string, ActiveBoardRow>();
  const warnings: IntegrityWarning[] = [];
  const conflicts: SourceConflict[] = [];

  for (const row of board.rows) {
    if (boardRows.has(row.workstreamId)) {
      warnings.push({
        code: "DUPLICATE_WORKSTREAM_ID",
        workstreamId: row.workstreamId,
        message: `${row.workstreamId} appears more than once on ${snapshot.activeBoardPath}.`,
        sources: [boardSource],
      });
      continue;
    }
    boardRows.set(row.workstreamId, row);
  }

  const workstreams: WorkstreamState[] = [];
  const seenIds = new Set<string>();

  for (const file of snapshot.workstreamFiles) {
    const fileNameId = parseWorkstreamId(file.path.split("/").pop() ?? file.path);
    const parsed = parseWorkstreamFile(file.markdown);
    const workstreamId = fileNameId ?? parsed.headingWorkstreamId;
    if (!workstreamId) continue; // Not a workstream file. Not an error.

    const fileSource = artifactSource(file.path, snapshot, file.htmlUrl, file.commitSha);

    if (fileNameId && parsed.headingWorkstreamId && fileNameId !== parsed.headingWorkstreamId) {
      warnings.push({
        code: "WORKSTREAM_ID_FILENAME_MISMATCH",
        workstreamId: fileNameId,
        message: `${file.path} is named ${fileNameId} but its heading says ${parsed.headingWorkstreamId}. Addressing by filename.`,
        sources: [fileSource],
      });
    }

    if (seenIds.has(workstreamId)) {
      warnings.push({
        code: "DUPLICATE_WORKSTREAM_ID",
        workstreamId,
        message: `${workstreamId} is defined by more than one file. Not merging them.`,
        sources: [fileSource],
      });
      continue;
    }
    seenIds.add(workstreamId);

    const row = boardRows.get(workstreamId);

    if (row && parsed.phase && row.phase && parsed.phase !== row.phase) {
      warnings.push({
        code: "BOARD_FILE_PHASE_MISMATCH",
        workstreamId,
        message: `${workstreamId} is ${row.phase} on the board and ${parsed.phase} in ${file.path}. Using the workstream file.`,
        sources: [boardSource, fileSource],
      });
      conflicts.push({
        field: `workstream.${workstreamId}.phase`,
        winner: { value: parsed.phase, source: fileSource },
        losers: [{ value: row.phase, source: boardSource }],
      });
    }

    if (row && parsed.status && row.status && parsed.status !== row.status) {
      warnings.push({
        code: "BOARD_FILE_STATUS_MISMATCH",
        workstreamId,
        message: `${workstreamId} is ${row.status} on the board and ${parsed.status} in ${file.path}. Using the workstream file.`,
        sources: [boardSource, fileSource],
      });
      conflicts.push({
        field: `workstream.${workstreamId}.status`,
        winner: { value: parsed.status, source: fileSource },
        losers: [{ value: row.status, source: boardSource }],
      });
    }

    const terminal =
      (parsed.phase && TERMINAL_PHASES.has(parsed.phase)) ||
      (parsed.status && TERMINAL_STATUSES.has(parsed.status));

    if (!row && !terminal) {
      warnings.push({
        code: "WORKSTREAM_MISSING_FROM_BOARD",
        workstreamId,
        message: `${workstreamId} is active in ${file.path} but has no row on ${snapshot.activeBoardPath}. It is invisible on the board.`,
        sources: [fileSource],
      });
    }

    if (row && terminal) {
      warnings.push({
        code: "COMPLETED_WORKSTREAM_STILL_ACTIVE",
        workstreamId,
        message: `${workstreamId} is finished in ${file.path} but still listed on ${snapshot.activeBoardPath}.`,
        sources: [boardSource, fileSource],
      });
    }

    const status = parsed.status ?? row?.status;
    const nextStep = parsed.nextStep ?? row?.nextStep;
    // Next Step is often written as "Blocked: <reason>"; keep the reason, drop the restatement.
    const blocker =
      status === "BLOCKED" && nextStep
        ? nextStep.replace(/^\s*blocked\s*[:\u2014\u2013-]\s*/i, "")
        : undefined;

    workstreams.push({
      projectId,
      workstreamId,
      title: parsed.title ?? row?.title ?? workstreamId,
      phase: parsed.phase ?? row?.phase,
      status,
      goal: parsed.goal,
      nextStep,
      // Build OS records a blocker as BLOCKED plus the reason in Next Step.
      blocker,
      openDecisions: parsed.openDecisions,
      relatedPrNumbers: [
        ...new Set([...(row?.relatedPrNumbers ?? []), ...parsed.relatedPrNumbers]),
      ].sort((a, b) => a - b),
      relatedDecisionIds: parsed.relatedDecisionIds,
      buildCardReady: parsed.buildCardReady,
      implementationState: parsed.implementationState,
      reviewState: parsed.reviewState,
      updatedAt: parsed.updatedAt,
      sourcePath: file.path,
      source: fileSource,
      conflicts: conflicts.filter((c) => c.field.includes(workstreamId)),
    });
  }

  for (const [workstreamId] of boardRows) {
    if (!seenIds.has(workstreamId)) {
      warnings.push({
        code: "BOARD_ROW_WITHOUT_FILE",
        workstreamId,
        message: `${workstreamId} is on ${snapshot.activeBoardPath} but has no workstream file. There is no detail behind the row.`,
        sources: [boardSource],
      });
    }
  }

  return { workstreams, warnings, conflicts };
}
