/**
 * Build OS state -> normalized events.
 *
 * Workstream files record state, not history, so most events here are transitions detected by
 * comparing against the previous projection. The exception is creation: a workstream the
 * Companion has never seen is new to the owner's feed even if the file is months old.
 */

import type { EventDraft } from "../../domain/events.ts";
import type { DecisionRecord, WorkstreamState } from "../../domain/state.ts";

export interface WorkstreamNormalizeOptions {
  projectId: string;
  previous?: Map<string, WorkstreamState>;
}

const SYSTEM_ACTOR = { type: "SYSTEM" as const, name: "build-os" };

export function normalizeWorkstreams(
  workstreams: WorkstreamState[],
  options: WorkstreamNormalizeOptions,
): EventDraft[] {
  const { projectId, previous } = options;
  const drafts: EventDraft[] = [];

  for (const ws of workstreams) {
    const prior = previous?.get(ws.workstreamId);
    const occurredAt = ws.updatedAt ?? ws.source.observedAt;
    const base = {
      projectId,
      source: ws.source,
      actor: SYSTEM_ACTOR,
      occurredAt,
      workstreamId: ws.workstreamId,
      raw: { workstream: ws } as Record<string, unknown>,
    };

    if (!prior) {
      drafts.push({
        ...base,
        eventType: "WORKSTREAM_CREATED",
        summaryShort: `${ws.workstreamId} — ${ws.title}${ws.phase ? ` (${ws.phase})` : ""}`,
        summaryDetail: ws.goal,
        // Keyed on identity alone: a workstream is created once, however often it is re-read.
        fingerprintParts: [ws.workstreamId, "created"],
      });
      continue;
    }

    if (ws.phase && prior.phase && ws.phase !== prior.phase) {
      const completed = ws.phase === "COMPLETE";
      drafts.push({
        ...base,
        eventType: completed ? "WORKSTREAM_COMPLETED" : "WORKSTREAM_PHASE_CHANGED",
        summaryShort: completed
          ? `${ws.workstreamId} complete: ${ws.title}`
          : `${ws.workstreamId} moved ${prior.phase} to ${ws.phase}: ${ws.title}`,
        summaryDetail: ws.nextStep,
        fingerprintParts: [ws.workstreamId, prior.phase, ws.phase, occurredAt],
      });
    }

    if (ws.status !== prior.status) {
      if (ws.status === "BLOCKED") {
        drafts.push({
          ...base,
          eventType: "WORKSTREAM_BLOCKED",
          summaryShort: `${ws.workstreamId} is blocked: ${ws.blocker ?? "no reason recorded"}`,
          fingerprintParts: [ws.workstreamId, "blocked", occurredAt],
        });
      } else if (prior.status === "BLOCKED") {
        drafts.push({
          ...base,
          eventType: "WORKSTREAM_UNBLOCKED",
          summaryShort: `${ws.workstreamId} is unblocked: ${ws.title}`,
          fingerprintParts: [ws.workstreamId, "unblocked", occurredAt],
        });
      }

      if (ws.status === "COMPLETE" && prior.status !== "COMPLETE" && ws.phase !== "COMPLETE") {
        drafts.push({
          ...base,
          eventType: "WORKSTREAM_COMPLETED",
          summaryShort: `${ws.workstreamId} complete: ${ws.title}`,
          fingerprintParts: [ws.workstreamId, "completed", occurredAt],
        });
      }
    }
  }

  return drafts;
}

export interface DecisionNormalizeOptions {
  projectId: string;
  previous?: Map<string, DecisionRecord>;
  observedAt: string;
}

/**
 * Only accepted decisions become events, and a status change to superseded becomes one too —
 * those are the moments that change what the project believes. Prose edits inside an existing
 * entry are not events.
 */
export function normalizeDecisions(
  decisions: DecisionRecord[],
  options: DecisionNormalizeOptions,
): EventDraft[] {
  const drafts: EventDraft[] = [];

  for (const decision of decisions) {
    if (decision.status !== "ACCEPTED") continue;
    const prior = options.previous?.get(decision.decisionId);
    if (prior && prior.status === decision.status) continue;

    drafts.push({
      projectId: options.projectId,
      eventType: "DECISION_ADDED",
      source: {
        sourceType: "BUILD_OS_ARTIFACT",
        sourceId: `${decision.sourcePath}#${decision.decisionId}`,
        sourceUrl: decision.sourceUrl,
        observedAt: options.observedAt,
      },
      actor: SYSTEM_ACTOR,
      occurredAt: decision.date ?? options.observedAt,
      summaryShort: `${decision.decisionId} accepted: ${decision.title}`,
      raw: { decision } as Record<string, unknown>,
      fingerprintParts: [decision.decisionId, decision.status],
    });
  }

  return drafts;
}
