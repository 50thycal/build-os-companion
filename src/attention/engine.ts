/**
 * The attention engine.
 *
 * Deterministic rules only. Given the same state and the same clock, this produces the same
 * items, every time, with a reason code and a sentence explaining each one. An LLM may later
 * re-rank *within* a severity band; it may never invent, promote, or suppress an item.
 *
 * The suppression rules matter as much as the surfacing rules. A `Needs Me` list that fires on
 * healthy autonomous work teaches the owner to ignore it, and an ignored list is worse than no
 * list — so every suppression is recorded as an explicit `AUTONOMOUS_PROGRESS` item rather than
 * as the absence of a rule.
 */

import { createHash } from "node:crypto";
import {
  DEFAULT_THRESHOLDS,
  needsOwner,
  severityRank,
  type AttentionItem,
  type AttentionThresholds,
  type ReasonCode,
  type Severity,
} from "../domain/attention.ts";
import type { CompanionEvent } from "../domain/events.ts";
import type {
  ProjectState,
  PullRequestState,
  SessionState,
  WorkstreamState,
} from "../domain/state.ts";
import type { SourceRef } from "../domain/provenance.ts";

export interface AttentionInput {
  state: ProjectState;
  /** GitHub login of the owner. Decides whether a review request is *theirs*. */
  ownerLogin: string;
  now: Date;
  thresholds?: AttentionThresholds;
  /** Used only to notice that syncing is currently failing. */
  recentEvents?: CompanionEvent[];
}

function itemId(projectId: string, entityType: string, entityId: string, reason: ReasonCode): string {
  const hash = createHash("sha256")
    .update([projectId, entityType, entityId, reason].join("|"), "utf8")
    .digest("hex");
  return `att_${hash.slice(0, 20)}`;
}

interface DraftItem {
  entityType: AttentionItem["entityType"];
  entityId: string;
  severity: Severity;
  reasonCode: ReasonCode;
  reasonText: string;
  recommendedAction: string;
  evidence: SourceRef[];
}

function hoursBetween(from: string, to: Date): number {
  return (to.getTime() - new Date(from).getTime()) / 3_600_000;
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

function activeSessionFor(pr: PullRequestState, sessions: SessionState[]): SessionState | undefined {
  return sessions.find(
    (s) =>
      s.relatedPrNumber === pr.number &&
      (s.status === "ACTIVE" || s.status === "WAITING") &&
      !s.stale,
  );
}

function pullRequestRules(
  pr: PullRequestState,
  sessions: SessionState[],
  ownerLogin: string,
  now: Date,
  thresholds: AttentionThresholds,
): DraftItem[] {
  // Merged and closed PRs are finished. Nothing about them needs the owner.
  if (pr.lifecycle === "MERGED" || pr.lifecycle === "CLOSED") return [];

  const items: DraftItem[] = [];
  const evidence = [pr.source];
  const entityId = `pr:${pr.number}`;
  const agent = activeSessionFor(pr, sessions);

  const suppressed = (what: string): DraftItem => ({
    entityType: "PULL_REQUEST",
    entityId,
    severity: "NONE",
    reasonCode: "AUTONOMOUS_PROGRESS",
    reasonText: `PR #${pr.number}: ${what}, and ${agent?.agentName ?? agent?.agent ?? "an agent"} is actively working on it.`,
    recommendedAction: "Nothing. Check back if the session goes quiet.",
    evidence,
  });

  if (pr.ciState === "FAILED") {
    items.push(
      agent
        ? suppressed("CI is failing")
        : {
            entityType: "PULL_REQUEST",
            entityId,
            severity: "HIGH",
            reasonCode: "PR_CI_FAILED",
            reasonText: `PR #${pr.number} has failing CI and no agent session is working on it.`,
            recommendedAction: "Open the failing check and decide whether to fix, re-run, or hand it to an agent.",
            evidence,
          },
    );
  }

  if (pr.reviewState === "CHANGES_REQUESTED") {
    items.push(
      agent
        ? suppressed("changes were requested")
        : {
            entityType: "PULL_REQUEST",
            entityId,
            severity: "HIGH",
            reasonCode: "REVIEW_CHANGES_REQUESTED",
            reasonText: `PR #${pr.number} has unresolved changes-requested and nobody is acting on it.`,
            recommendedAction: "Decide whether the requested changes are yours to make or to delegate.",
            evidence,
          },
    );
  }

  if (pr.mergeability === "CONFLICTED") {
    items.push(
      agent
        ? suppressed("it has a merge conflict")
        : {
            entityType: "PULL_REQUEST",
            entityId,
            severity: "HIGH",
            reasonCode: "MERGE_CONFLICT",
            reasonText: `PR #${pr.number} cannot merge: it conflicts with ${pr.baseBranch}.`,
            recommendedAction: `Merge ${pr.baseBranch} into the branch and resolve, or ask an agent to.`,
            evidence,
          },
    );
  }

  if (pr.reviewState === "REVIEW_REQUESTED" && pr.requestedReviewers.includes(ownerLogin)) {
    items.push({
      entityType: "PULL_REQUEST",
      entityId,
      severity: "HIGH",
      reasonCode: "PR_WAITING_FOR_OWNER_REVIEW",
      reasonText: `PR #${pr.number} is waiting on your review: ${pr.title}`,
      recommendedAction: "Review the PR, or reassign it.",
      evidence,
    });
  }

  // Stale only when nothing else already explains the silence.
  const quietFor = hoursBetween(pr.updatedAt, now);
  const alreadyExplained = items.some((i) => i.severity !== "NONE") || agent !== undefined;
  if (
    !alreadyExplained &&
    pr.lifecycle === "OPEN" &&
    quietFor > thresholds.stalePullRequestHours
  ) {
    items.push({
      entityType: "PULL_REQUEST",
      entityId,
      severity: "MEDIUM",
      reasonCode: "PR_STALE",
      reasonText: `PR #${pr.number} has not moved for ${Math.floor(quietFor / 24)} days and nothing is working on it.`,
      recommendedAction: "Decide whether to land it, close it, or hand it back to an agent.",
      evidence,
    });
  }

  if (items.length === 0) {
    items.push({
      entityType: "PULL_REQUEST",
      entityId,
      severity: "NONE",
      reasonCode: "AUTONOMOUS_PROGRESS",
      reasonText: `PR #${pr.number} is healthy: ${pr.ciState.toLowerCase()} CI, review ${pr.reviewState.toLowerCase().replace("_", " ")}.`,
      recommendedAction: "Nothing.",
      evidence,
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// Workstreams
// ---------------------------------------------------------------------------

function workstreamRules(
  ws: WorkstreamState,
  sessions: SessionState[],
  now: Date,
  thresholds: AttentionThresholds,
): DraftItem[] {
  const entityId = ws.workstreamId;
  const evidence = [ws.source];

  // Finished work is not attention.
  if (ws.status === "COMPLETE" || ws.status === "ABANDONED" || ws.phase === "COMPLETE") return [];

  // A deliberately paused workstream is a decision the owner already made. It never goes stale,
  // and its open decisions are not pending on them today.
  if (ws.status === "PAUSED") {
    return [
      {
        entityType: "WORKSTREAM",
        entityId,
        severity: "NONE",
        reasonCode: "AUTONOMOUS_PROGRESS",
        reasonText: `${ws.workstreamId} is paused on purpose, so it is not reported as stalled.`,
        recommendedAction: "Nothing until you choose to resume it.",
        evidence,
      },
    ];
  }

  const items: DraftItem[] = [];

  if (ws.status === "BLOCKED") {
    // A session blocker flagged `needs_owner` is what turns "blocked" into "blocked on you".
    const ownerBlocked = sessions.some(
      (s) => s.workstreamId === ws.workstreamId && s.blockers.some((b) => b.needsOwner),
    );
    items.push({
      entityType: "WORKSTREAM",
      entityId,
      severity: ownerBlocked ? "HIGH" : "MEDIUM",
      reasonCode: "WORKSTREAM_BLOCKED",
      reasonText: ownerBlocked
        ? `${ws.workstreamId} is blocked on you: ${ws.blocker ?? "no reason recorded"}`
        : `${ws.workstreamId} is blocked: ${ws.blocker ?? "no reason recorded"}`,
      recommendedAction: ownerBlocked
        ? "Unblock it, or say what would."
        : "Check whether the blocker is still real.",
      evidence,
    });
  }

  if (ws.openDecisions.length > 0) {
    const first = ws.openDecisions[0]!;
    items.push({
      entityType: "WORKSTREAM",
      entityId,
      severity: "HIGH",
      reasonCode: "OWNER_DECISION_REQUIRED",
      reasonText:
        ws.openDecisions.length === 1
          ? `${ws.workstreamId} is waiting on your decision: ${first.question}`
          : `${ws.workstreamId} is waiting on ${ws.openDecisions.length} decisions, starting with: ${first.question}`,
      recommendedAction: "Answer the open decisions so the design can move on.",
      evidence,
    });
  }

  if (ws.phase === "BUILD_CARD") {
    items.push({
      entityType: "WORKSTREAM",
      entityId,
      severity: "HIGH",
      reasonCode: "BUILD_CARD_AWAITING_APPROVAL",
      reasonText: `${ws.workstreamId} has a Build Card waiting for your approval: ${ws.title}`,
      recommendedAction: "Read the Build Card and approve it, or send it back.",
      evidence,
    });
  }

  const updatedAt = ws.updatedAt;
  const workingSession = sessions.some(
    (s) => s.workstreamId === ws.workstreamId && s.status === "ACTIVE" && !s.stale,
  );

  if (
    items.length === 0 &&
    !workingSession &&
    ws.phase !== "IDEA" &&
    updatedAt !== undefined &&
    hoursBetween(updatedAt, now) > thresholds.staleWorkstreamDays * 24
  ) {
    const days = Math.floor(hoursBetween(updatedAt, now) / 24);
    items.push({
      entityType: "WORKSTREAM",
      entityId,
      severity: "MEDIUM",
      reasonCode: "WORKSTREAM_STALE",
      reasonText: `${ws.workstreamId} has not been checkpointed for ${days} days while still marked active.`,
      recommendedAction: "Resume it, pause it deliberately, or abandon it.",
      evidence,
    });
  }

  if (items.length === 0) {
    items.push({
      entityType: "WORKSTREAM",
      entityId,
      severity: "NONE",
      reasonCode: "AUTONOMOUS_PROGRESS",
      reasonText: `${ws.workstreamId} is progressing normally${ws.phase ? ` in ${ws.phase}` : ""}.`,
      recommendedAction: "Nothing.",
      evidence,
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function sessionRules(session: SessionState): DraftItem[] {
  const entityId = session.sessionId;
  const evidence: SourceRef[] = [
    {
      sourceType: "SESSION_CHECKPOINT",
      sourceId: `session:${session.sessionId}`,
      observedAt: session.updatedAt,
    },
  ];

  if (session.status === "COMPLETED" || session.status === "ABANDONED") return [];

  if (session.status === "BLOCKED") {
    const ownerBlocker = session.blockers.find((b) => b.needsOwner);
    return [
      {
        entityType: "SESSION",
        entityId,
        severity: ownerBlocker ? "HIGH" : "LOW",
        reasonCode: "SESSION_BLOCKED",
        reasonText: ownerBlocker
          ? `${session.agentName ?? session.agent} is blocked on you: ${ownerBlocker.description}`
          : `${session.agentName ?? session.agent} is blocked: ${session.blockers[0]?.description ?? "no reason recorded"}`,
        recommendedAction: ownerBlocker
          ? "Answer the blocker so the session can continue."
          : "Nothing yet; the session is not waiting on you.",
        evidence,
      },
    ];
  }

  if (session.status === "UNKNOWN" && session.stale) {
    return [
      {
        entityType: "SESSION",
        entityId,
        severity: "MEDIUM",
        reasonCode: "SESSION_STALE",
        reasonText: `${session.agentName ?? session.agent} stopped checkpointing; whether this work is still running is unknown.`,
        recommendedAction: "Check the session, or treat the work as dropped and restart it.",
        evidence,
      },
    ];
  }

  return [
    {
      entityType: "SESSION",
      entityId,
      severity: "NONE",
      reasonCode: "AUTONOMOUS_PROGRESS",
      reasonText: `${session.agentName ?? session.agent} is working: ${session.inProgress[0] ?? session.objective}`,
      recommendedAction: "Nothing.",
      evidence,
    },
  ];
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

function projectRules(state: ProjectState, recentEvents: CompanionEvent[]): DraftItem[] {
  const items: DraftItem[] = [];

  if (state.integrityWarnings.length > 0) {
    const first = state.integrityWarnings[0]!;
    items.push({
      entityType: "PROJECT",
      entityId: state.projectId,
      severity: "LOW",
      reasonCode: "BUILD_OS_INTEGRITY",
      reasonText:
        state.integrityWarnings.length === 1
          ? first.message
          : `${state.integrityWarnings.length} Build OS records disagree, starting with: ${first.message}`,
      recommendedAction: "Reconcile the board and the workstream files.",
      evidence: first.sources,
    });
  }

  const syncFailure = recentEvents.filter((e) => e.eventType === "SYNC_FAILED").at(-1);
  if (syncFailure) {
    items.push({
      entityType: "PROJECT",
      entityId: state.projectId,
      severity: "MEDIUM",
      reasonCode: "SYNC_FAILING",
      reasonText: syncFailure.summaryShort,
      recommendedAction: "Check repository access; state shown is the last good sync.",
      evidence: [syncFailure.source],
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export function computeAttention(input: AttentionInput): AttentionItem[] {
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;
  const { state, now, ownerLogin } = input;
  const createdAt = now.toISOString();

  const drafts: DraftItem[] = [
    ...state.pullRequests.flatMap((pr) =>
      pullRequestRules(pr, state.sessions, ownerLogin, now, thresholds),
    ),
    ...state.workstreams.flatMap((ws) => workstreamRules(ws, state.sessions, now, thresholds)),
    ...state.sessions.flatMap((session) => sessionRules(session)),
    ...projectRules(state, input.recentEvents ?? []),
  ];

  return drafts
    .map((draft) => ({
      id: itemId(state.projectId, draft.entityType, draft.entityId, draft.reasonCode),
      projectId: state.projectId,
      createdAt,
      ...draft,
    }))
    .sort((a, b) => {
      const bySeverity = severityRank(b.severity) - severityRank(a.severity);
      if (bySeverity !== 0) return bySeverity;
      return a.id.localeCompare(b.id);
    });
}

/** The `Needs Me` view: everything at MEDIUM or above. */
export function needsMe(items: AttentionItem[]): AttentionItem[] {
  return items.filter((item) => needsOwner(item.severity));
}
