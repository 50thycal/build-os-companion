/**
 * Session checkpoints -> session state and events.
 *
 * A checkpoint is subordinate to everything GitHub says. It exists to close the visibility gap
 * between durable Build OS checkpoints, not to replace them.
 */

import type { EventDraft } from "../../domain/events.ts";
import type {
  SessionState,
  SessionStatus,
  WorkstreamPhase,
} from "../../domain/state.ts";
import type { SourceRef } from "../../domain/provenance.ts";
import type { AttentionThresholds } from "../../domain/attention.ts";
import type { SessionCheckpointV1 } from "./validate.ts";

export interface CheckpointContext {
  projectId: string;
  /** `GITHUB` for a committed checkpoint, `API` for an ephemeral posted one. */
  checkpointSource: "GITHUB" | "API";
  sourceUrl?: string;
  receivedAt: string;
}

function checkpointSourceRef(
  checkpoint: SessionCheckpointV1,
  context: CheckpointContext,
): SourceRef {
  return {
    sourceType: "SESSION_CHECKPOINT",
    sourceId: `session:${checkpoint.session_id}`,
    sourceUrl: context.sourceUrl,
    observedAt: context.receivedAt,
  };
}

export function toSessionState(
  checkpoint: SessionCheckpointV1,
  context: CheckpointContext,
  previous?: SessionState,
): SessionState {
  return {
    projectId: context.projectId,
    sessionId: checkpoint.session_id,
    workstreamId: checkpoint.workstream_id ?? undefined,
    agent: checkpoint.agent,
    agentName: checkpoint.agent_name ?? undefined,
    sessionKind: checkpoint.session_kind,
    objective: checkpoint.objective,
    phase: (checkpoint.phase as WorkstreamPhase | undefined) ?? undefined,
    status: checkpoint.status,
    startedAt: previous?.startedAt ?? checkpoint.updated_at,
    updatedAt: checkpoint.updated_at,
    completedAt:
      checkpoint.status === "COMPLETED" || checkpoint.status === "ABANDONED"
        ? checkpoint.updated_at
        : undefined,
    relatedPrNumber: checkpoint.related_pr ?? undefined,
    completed: checkpoint.completed ?? [],
    inProgress: checkpoint.in_progress ?? [],
    blockers: (checkpoint.blockers ?? []).map((b) => ({
      description: b.description,
      needsOwner: b.needs_owner,
    })),
    nextStep: checkpoint.next_step ?? undefined,
    checkpointSource: context.checkpointSource,
    stale: false,
  };
}

export function normalizeCheckpoint(
  checkpoint: SessionCheckpointV1,
  context: CheckpointContext,
  previous?: SessionState,
): EventDraft[] {
  const source = checkpointSourceRef(checkpoint, context);
  const actor = {
    type: checkpoint.agent === "human" ? ("HUMAN" as const) : ("AGENT" as const),
    name: checkpoint.agent_name ?? checkpoint.agent,
  };
  const base = {
    projectId: context.projectId,
    source,
    actor,
    occurredAt: checkpoint.updated_at,
    workstreamId: checkpoint.workstream_id ?? undefined,
    sessionId: checkpoint.session_id,
    pullRequestNumber: checkpoint.related_pr ?? undefined,
    raw: { checkpointSource: context.checkpointSource } as Record<string, unknown>,
  };

  const drafts: EventDraft[] = [];

  if (!previous) {
    drafts.push({
      ...base,
      eventType: "SESSION_STARTED",
      summaryShort: `${actor.name} started a ${checkpoint.session_kind.toLowerCase()} session: ${checkpoint.objective}`,
      fingerprintParts: [checkpoint.session_id, "started"],
    });
  }

  const statusChanged = previous?.status !== checkpoint.status;

  if (statusChanged && checkpoint.status === "BLOCKED") {
    const blocker = checkpoint.blockers?.[0]?.description ?? "no reason recorded";
    drafts.push({
      ...base,
      eventType: "SESSION_BLOCKED",
      summaryShort: `${actor.name} session blocked: ${blocker}`,
      fingerprintParts: [checkpoint.session_id, "blocked", checkpoint.updated_at],
    });
  }

  if (statusChanged && (checkpoint.status === "COMPLETED" || checkpoint.status === "ABANDONED")) {
    drafts.push({
      ...base,
      eventType: "SESSION_COMPLETED",
      summaryShort: `${actor.name} session ${checkpoint.status.toLowerCase()}: ${checkpoint.objective}`,
      fingerprintParts: [checkpoint.session_id, checkpoint.status, checkpoint.updated_at],
    });
  }

  // A routine checkpoint is deliberately low-importance: it is progress, not news.
  if (previous && !statusChanged) {
    drafts.push({
      ...base,
      eventType: "SESSION_CHECKPOINTED",
      summaryShort: `${actor.name} checkpointed: ${
        checkpoint.in_progress?.[0] ?? checkpoint.objective
      }`,
      fingerprintParts: [checkpoint.session_id, checkpoint.updated_at],
    });
  }

  return drafts;
}

/**
 * Demote sessions that have gone quiet.
 *
 * `ACTIVE` and `WAITING` become `UNKNOWN`: the Companion genuinely does not know whether that
 * work is still happening, and saying so is the honest answer.
 *
 * `BLOCKED` is marked stale but keeps its status. Silence does not unblock anything, and
 * demoting it would drop the very attention item the owner needs to see.
 *
 * Nothing here ever produces `COMPLETED`.
 */
export function applyStaleness(
  sessions: SessionState[],
  now: Date,
  thresholds: AttentionThresholds,
): SessionState[] {
  const cutoff = new Date(now.getTime() - thresholds.staleSessionHours * 3_600_000).toISOString();

  return sessions.map((session) => {
    if (session.updatedAt >= cutoff) return session;

    switch (session.status) {
      case "ACTIVE":
      case "WAITING":
        return { ...session, status: "UNKNOWN" as SessionStatus, stale: true };
      case "BLOCKED":
        return { ...session, stale: true };
      default:
        return session;
    }
  });
}
