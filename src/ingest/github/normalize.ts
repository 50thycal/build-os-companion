/**
 * GitHub observation -> normalized events.
 *
 * Polling shows current state, not transitions. Two kinds of event come out of that:
 *
 * - **Intrinsic** events, derivable from immutable facts — a PR's `createdAt`, a review's id and
 *   submission time, a check run's id and completion time. These are safe on every poll because
 *   their fingerprint cannot change.
 * - **Transition** events, which need the previous projection to see — `PR_READY_FOR_REVIEW`,
 *   `PR_UPDATED`. These are emitted only when a previous state exists.
 *
 * The consequence is deliberate: the first sync of a repository backfills intrinsic history and
 * stays quiet about transitions it never witnessed. Inventing a "ready for review" moment the
 * Companion did not see would be inference presented as fact.
 */

import type { EventDraft } from "../../domain/events.ts";
import type { PullRequestState } from "../../domain/state.ts";
import type { SourceRef } from "../../domain/provenance.ts";
import { derivePullRequestState } from "./derive.ts";
import type { GitHubObservation, GitHubPullRequestObservation, GitHubSyncFailure } from "./types.ts";

export interface NormalizeOptions {
  projectId: string;
  /** Previous projection, keyed by PR number. Absent on first sync. */
  previous?: Map<number, PullRequestState>;
}

function prSource(
  pr: GitHubPullRequestObservation,
  observedAt: string,
  suffix?: string,
): SourceRef {
  return {
    sourceType: "GITHUB_STATE",
    sourceId: suffix ? `pr:${pr.number}:${suffix}` : `pr:${pr.number}`,
    sourceUrl: pr.htmlUrl,
    observedAt,
  };
}

function actorFor(pr: GitHubPullRequestObservation) {
  return { type: pr.authorIsBot ? ("BOT" as const) : ("HUMAN" as const), name: pr.author };
}

/**
 * Every PR event carries the snapshot from the observation that produced it, so the projection
 * can rebuild current state from the ledger alone rather than needing a second store.
 */
function snapshotRaw(
  projectId: string,
  pr: GitHubPullRequestObservation,
  observedAt: string,
): Record<string, unknown> {
  return {
    observedAt,
    pr: derivePullRequestState(projectId, pr, prSource(pr, observedAt)),
  };
}

export function normalizeGitHubObservation(
  observation: GitHubObservation,
  options: NormalizeOptions,
): EventDraft[] {
  const { projectId, previous } = options;
  const drafts: EventDraft[] = [];

  for (const pr of observation.pullRequests) {
    const raw = snapshotRaw(projectId, pr, observation.observedAt);
    const actor = actorFor(pr);
    const prior = previous?.get(pr.number);

    // --- intrinsic: opened -------------------------------------------------
    drafts.push({
      projectId,
      eventType: "PR_OPENED",
      source: prSource(pr, observation.observedAt, "opened"),
      actor,
      occurredAt: pr.createdAt,
      pullRequestNumber: pr.number,
      summaryShort: `PR #${pr.number} opened: ${pr.title}`,
      raw,
      fingerprintParts: [pr.number, pr.createdAt],
    });

    // --- intrinsic: merged / closed ---------------------------------------
    if (pr.merged && pr.mergedAt) {
      drafts.push({
        projectId,
        eventType: "PR_MERGED",
        source: prSource(pr, observation.observedAt, "merged"),
        actor,
        occurredAt: pr.mergedAt,
        pullRequestNumber: pr.number,
        summaryShort: `PR #${pr.number} merged: ${pr.title}`,
        raw,
        fingerprintParts: [pr.number, pr.mergedAt],
      });
    } else if (pr.state === "closed" && pr.closedAt) {
      drafts.push({
        projectId,
        eventType: "PR_CLOSED",
        source: prSource(pr, observation.observedAt, "closed"),
        actor,
        occurredAt: pr.closedAt,
        pullRequestNumber: pr.number,
        summaryShort: `PR #${pr.number} closed without merging: ${pr.title}`,
        raw,
        fingerprintParts: [pr.number, pr.closedAt],
      });
    }

    // --- intrinsic: reviews ------------------------------------------------
    for (const review of pr.reviews) {
      if (review.state === "PENDING" || review.state === "DISMISSED") continue;
      const changesRequested = review.state === "CHANGES_REQUESTED";
      drafts.push({
        projectId,
        eventType: changesRequested ? "PR_CHANGES_REQUESTED" : "PR_REVIEWED",
        source: {
          sourceType: "GITHUB_STATE",
          sourceId: `review:${review.id}`,
          sourceUrl: review.htmlUrl,
          observedAt: observation.observedAt,
        },
        actor: { type: "HUMAN", name: review.author },
        occurredAt: review.submittedAt,
        pullRequestNumber: pr.number,
        summaryShort: changesRequested
          ? `${review.author} requested changes on PR #${pr.number}`
          : `${review.author} reviewed PR #${pr.number} (${review.state.toLowerCase()})`,
        raw,
        fingerprintParts: [review.id, review.state, review.submittedAt],
      });
    }

    // --- intrinsic: checks -------------------------------------------------
    for (const check of pr.checks) {
      if (check.status === "completed" && check.completedAt) {
        const failed =
          check.conclusion === "failure" ||
          check.conclusion === "timed_out" ||
          check.conclusion === "action_required";
        // Cancelled and skipped runs are not outcomes worth telling the owner about.
        if (!failed && check.conclusion !== "success" && check.conclusion !== "neutral") continue;
        drafts.push({
          projectId,
          eventType: failed ? "CI_FAILED" : "CI_PASSED",
          source: {
            sourceType: "GITHUB_STATE",
            sourceId: `check:${check.id}`,
            sourceUrl: check.htmlUrl,
            observedAt: observation.observedAt,
          },
          actor: { type: "BOT", name: check.name },
          occurredAt: check.completedAt,
          pullRequestNumber: pr.number,
          summaryShort: failed
            ? `CI failed on PR #${pr.number}: ${check.name}`
            : `CI passed on PR #${pr.number}: ${check.name}`,
          raw,
          fingerprintParts: [check.id, check.conclusion, check.completedAt],
        });
      } else {
        drafts.push({
          projectId,
          eventType: "CI_STARTED",
          source: {
            sourceType: "GITHUB_STATE",
            sourceId: `check:${check.id}`,
            sourceUrl: check.htmlUrl,
            observedAt: observation.observedAt,
          },
          actor: { type: "BOT", name: check.name },
          occurredAt: check.startedAt,
          pullRequestNumber: pr.number,
          summaryShort: `CI started on PR #${pr.number}: ${check.name}`,
          raw,
          fingerprintParts: [check.id, check.startedAt],
        });
      }
    }

    // --- transitions: need a previous projection ---------------------------
    if (prior) {
      if (prior.draft && !pr.draft && pr.state === "open") {
        drafts.push({
          projectId,
          eventType: "PR_READY_FOR_REVIEW",
          source: prSource(pr, observation.observedAt, "ready"),
          actor,
          occurredAt: pr.updatedAt,
          pullRequestNumber: pr.number,
          summaryShort: `PR #${pr.number} is ready for review: ${pr.title}`,
          raw,
          fingerprintParts: [pr.number, "ready", pr.updatedAt],
        });
      }

      const covered =
        prior.updatedAt === pr.updatedAt ||
        pr.mergedAt === pr.updatedAt ||
        pr.closedAt === pr.updatedAt;

      if (!covered) {
        drafts.push({
          projectId,
          eventType: "PR_UPDATED",
          source: prSource(pr, observation.observedAt, "updated"),
          actor,
          occurredAt: pr.updatedAt,
          pullRequestNumber: pr.number,
          summaryShort: `PR #${pr.number} updated: ${pr.title}`,
          raw,
          fingerprintParts: [pr.number, pr.updatedAt],
        });
      }
    }
  }

  return drafts;
}

/**
 * A failed poll becomes an event rather than silence. The owner needs to know the difference
 * between "nothing happened" and "we could not look".
 */
export function normalizeSyncFailure(projectId: string, failure: GitHubSyncFailure): EventDraft[] {
  return [
    {
      projectId,
      eventType: "SYNC_FAILED",
      source: {
        sourceType: "GITHUB_STATE",
        sourceId: `sync:${failure.repositoryFullName}`,
        observedAt: failure.observedAt,
      },
      actor: { type: "SYSTEM", name: "companion" },
      occurredAt: failure.observedAt,
      summaryShort: `Could not sync ${failure.repositoryFullName}: ${failure.reason}`,
      raw: { statusCode: failure.statusCode },
      // Deduped per hour: a repository that is unreachable all afternoon is one problem, not
      // one problem per poll.
      fingerprintParts: [failure.reason, failure.observedAt.slice(0, 13)],
    },
  ];
}
