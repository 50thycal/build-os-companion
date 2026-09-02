/**
 * Build OS v0.8 operating modes, v0.10 unsupported verdicts, v0.11 relayed acceptances.
 *
 * The single rule underneath all of it: **an acceptance is not an approval.** `Owner-accepted`
 * records that the owner took responsibility for work no independent party reviewed. That is a
 * true statement and a much weaker one, and every test here exists to stop the two collapsing
 * into each other — in the field it names, in the verdict it is, or in the gate it opens.
 */

import { describe, expect, it } from "vitest";

import { detectBuildOs } from "../src/ingest/buildos/detect.ts";
import { parseReviewState } from "../src/ingest/buildos/parse.ts";
import { parseCommentVerdict } from "../src/ingest/github/comment-verdict.ts";
import {
  deriveApprovedHeadShas,
  deriveOwnerAcceptances,
  deriveRecordedPositionCount,
} from "../src/ingest/github/derive.ts";
import { checkReviewGate } from "../src/projection/review-gate.ts";
import { isAcceptingVerdict, isApprovingVerdict } from "../src/domain/state.ts";
import type { GitHubPullRequestObservation } from "../src/ingest/github/types.ts";
import type {
  IntegrityWarning,
  PullRequestState,
  ReviewRecord,
  WorkstreamState,
} from "../src/domain/state.ts";
import type { SourceRef } from "../src/domain/provenance.ts";

const ACCEPTED_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FINAL_HEAD = "cccccccccccccccccccccccccccccccccccccccc";

const SOURCE: SourceRef = {
  sourceType: "BUILD_OS_ARTIFACT",
  sourceId: "docs/workstreams/WS-008.md",
  sourceUrl: "https://github.com/50thycal/build-os/blob/main/docs/workstreams/WS-008.md",
  observedAt: "2026-09-02T09:00:00Z",
};

const PR_SOURCE: SourceRef = {
  sourceType: "GITHUB_STATE",
  sourceId: "pr:16",
  sourceUrl: "https://github.com/50thycal/build-os/pull/16",
  observedAt: "2026-09-02T09:00:00Z",
};

function record(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return { prNumber: 16, verdict: "OWNER_ACCEPTED", acceptedHead: ACCEPTED_HEAD, finalized: true, ...overrides };
}

function workstream(overrides: Partial<WorkstreamState> = {}): WorkstreamState {
  return {
    projectId: "proj_build_os",
    workstreamId: "WS-008",
    title: "Mobile-first owner interface",
    phase: "REVIEW",
    status: "ACTIVE",
    openDecisions: [],
    relatedPrNumbers: [16],
    relatedDecisionIds: [],
    buildCardReady: true,
    protocolVersion: "v0.11",
    protocolVersionSource: "WORKSTREAM",
    reviewRecords: [record()],
    sourcePath: "docs/workstreams/WS-008.md",
    source: SOURCE,
    conflicts: [],
    ...overrides,
  };
}

function pullRequest(overrides: Partial<PullRequestState> = {}): PullRequestState {
  return {
    projectId: "proj_build_os",
    number: 16,
    title: "The owner interface",
    lifecycle: "OPEN",
    draft: false,
    headBranch: "claude/owner-interface",
    headSha: ACCEPTED_HEAD,
    baseBranch: "main",
    author: "50thycal",
    createdAt: "2026-08-30T09:00:00Z",
    updatedAt: "2026-09-02T09:00:00Z",
    mergeability: "CLEAN",
    reviewState: "REVIEW_REQUESTED",
    ciState: "PASSED",
    requestedReviewers: [],
    approvedHeadShas: [],
    ownerAcceptances: [{ author: "50thycal", actor: "owner", head: ACCEPTED_HEAD, at: "2026-09-02T08:00:00Z" }],
    recordedPositions: 1,
    changesRequestedBy: [],
    mutatedEvidence: [],
    workstreamIds: ["WS-008"],
    sourceUrl: "https://github.com/50thycal/build-os/pull/16",
    source: PR_SOURCE,
    ...overrides,
  };
}

const codes = (warnings: IntegrityWarning[]): string[] => warnings.map((w) => w.code).sort();
const SOLO = { operatingMode: "solo" } as const;

describe("an acceptance is never an approval", () => {
  it("keeps Owner-accepted out of isApprovingVerdict", () => {
    expect(isApprovingVerdict("OWNER_ACCEPTED")).toBe(false);
    expect(isApprovingVerdict("APPROVED")).toBe(true);
  });

  it("admits it only where a caller asks for an acceptance by name", () => {
    expect(isAcceptingVerdict("OWNER_ACCEPTED")).toBe(true);
    expect(isAcceptingVerdict("CHANGES_REQUIRED")).toBe(false);
  });
});

describe("reading the project's operating mode", () => {
  const detect = (input: { agentInstructions?: string; versionFile?: string }) =>
    detectBuildOs({ paths: ["docs/workstreams/ACTIVE.md"], ...input }).operatingMode;

  it("reads a declaration from the framework block", () => {
    expect(detect({ agentInstructions: "- Operating mode: solo\n" })).toBe("solo");
    expect(detect({ agentInstructions: "- Operating mode: reviewed\n" })).toBe("reviewed");
  });

  it("reports no mode when the project declares none, rather than inventing one", () => {
    // Absent reads as `reviewed` downstream; the distinction is kept here so a caller can tell a
    // declaration from a default.
    expect(detect({ agentInstructions: "- Adopted version: v0.11\n" })).toBeUndefined();
  });

  it("falls back to VERSION.md only for a repository with no instructions file", () => {
    // Canonical Build OS: a protocol repository with no CLAUDE.md, which keeps its framework
    // block in VERSION.md and says so there. Its table shape is the declaration.
    const versionFile = "| Field | Value |\n|---|---|\n| Operating mode | `solo` — see `DEC-021` |\n";
    expect(detect({ versionFile })).toBe("solo");
    // With an instructions file present, that file is the framework block. A project that has one
    // and declares no mode has said `reviewed` by omission.
    expect(detect({ agentInstructions: "- Adopted version: v0.11\n", versionFile })).toBeUndefined();
  });

  it("never reads a worked example as a declaration", () => {
    // The canonical README carries an example block declaring `reviewed`. Reading it would give a
    // genuinely solo project the opposite answer — worse than having none.
    const readme = "Add this:\n\n```markdown\n- Operating mode: reviewed\n```\n";
    expect(detect({ versionFile: readme })).toBeUndefined();
  });
});

describe("Accepted head is its own field", () => {
  it("reads it separately from Reviewed head", () => {
    const parsed = parseReviewState(
      `**Verdict:** Owner-accepted\n**Accepted head:** ${ACCEPTED_HEAD}\n**Finalization:** pushed\n`,
    );
    expect(parsed.records[0]).toMatchObject({
      verdict: "OWNER_ACCEPTED",
      acceptedHead: ACCEPTED_HEAD,
      finalized: true,
    });
    expect(parsed.records[0]!.reviewedHead).toBeUndefined();
  });

  it("does not let an Accepted head column be read as a Reviewed head", () => {
    /**
     * `columnIndex` matches on substring, so a bare `head` needle finds `Accepted head` too.
     * Left alone this turned every solo acceptance into an approval for the gate — the one
     * conflation v0.8 exists to prevent, arriving silently through a column name.
     */
    const parsed = parseReviewState(
      `| PR | Verdict | Accepted head | Finalization |\n|---|---|---|---|\n| #16 | Owner-accepted | ${ACCEPTED_HEAD} | pushed |\n`,
    );
    expect(parsed.records[0]!.acceptedHead).toBe(ACCEPTED_HEAD);
    expect(parsed.records[0]!.reviewedHead).toBeUndefined();
  });

  it("still reads a pre-v0.8 table's bare head column as the reviewed one", () => {
    const parsed = parseReviewState(
      `| PR | Verdict | Head | Finalization |\n|---|---|---|---|\n| #16 | Approved | ${ACCEPTED_HEAD} | pushed |\n`,
    );
    expect(parsed.records[0]!.reviewedHead).toBe(ACCEPTED_HEAD);
  });

  it("refuses an abbreviated accepted head rather than half-believing it", () => {
    const parsed = parseReviewState("**Verdict:** Owner-accepted\n**Accepted head:** aaaaaaa\n");
    expect(parsed.acceptedHeadMalformed).toBe(true);
    expect(parsed.records[0]!.acceptedHead).toBeUndefined();
  });
});

describe("Owner-accepted as a comment verdict", () => {
  it("keys on the field name, and leaves the reviewed head absent", () => {
    const verdict = parseCommentVerdict(
      `Build OS review verdict: Owner-accepted\nAccepted head: ${ACCEPTED_HEAD}\nReview actor: owner\nImplementation actor reviewed: claude-implementation-session\n`,
    );
    expect(verdict).toMatchObject({ verdict: "OWNER_ACCEPTED", acceptedHead: ACCEPTED_HEAD });
    expect(verdict!.reviewedHead).toBeUndefined();
  });

  it("refuses an acceptance that names a reviewed head instead", () => {
    // It would be claiming a review happened, which is the one thing this verdict denies.
    expect(
      parseCommentVerdict(
        `Build OS review verdict: Owner-accepted\nReviewed head: ${ACCEPTED_HEAD}\nReview actor: owner\n`,
      ),
    ).toBeUndefined();
  });

  it("keeps the prose that says an acceptance was relayed", () => {
    /**
     * v0.11. A relayed acceptance is identical in every field to one the owner posted and differs
     * only in these words, so dropping them would leave the two indistinguishable — which is the
     * distinction the relay form was written to preserve.
     */
    const verdict = parseCommentVerdict(
      `Build OS review verdict: Owner-accepted\nAccepted head: ${ACCEPTED_HEAD}\nReview actor: owner\nImplementation actor reviewed: claude-implementation-session\n\nRelayed by the implementation session from the owner's decision in chat.\n`,
    );
    expect(verdict!.note).toContain("Relayed");
  });

  it("does not let an acceptance reach approvedHeadShas", () => {
    const observation = acceptanceObservation();
    expect(deriveApprovedHeadShas(observation)).toEqual([]);
    expect(deriveOwnerAcceptances(observation)).toMatchObject([{ head: ACCEPTED_HEAD, actor: "owner" }]);
    expect(deriveRecordedPositionCount(observation)).toBe(1);
  });
});

function acceptanceObservation(): GitHubPullRequestObservation {
  return {
    number: 16,
    title: "The owner interface",
    state: "open",
    draft: false,
    merged: false,
    createdAt: "2026-08-30T09:00:00Z",
    updatedAt: "2026-09-02T09:00:00Z",
    headRef: "claude/owner-interface",
    headSha: ACCEPTED_HEAD,
    baseRef: "main",
    author: "50thycal",
    authorIsBot: false,
    htmlUrl: "https://github.com/50thycal/build-os/pull/16",
    body: "Implementation actor: claude-implementation-session",
    requestedReviewers: [],
    checks: [],
    reviews: [],
    comments: [
      {
        id: 1,
        htmlUrl: "https://github.com/50thycal/build-os/pull/16#issuecomment-1",
        author: "50thycal",
        createdAt: "2026-09-02T08:00:00Z",
        body: `Build OS review verdict: Owner-accepted\nAccepted head: ${ACCEPTED_HEAD}\nReview actor: owner\nImplementation actor reviewed: claude-implementation-session\n`,
      },
    ],
  };
}

describe("the gate, given a mode", () => {
  it("lets a solo project's acceptance clear its own head", () => {
    expect(checkReviewGate([workstream()], [pullRequest()], SOLO)).toEqual([]);
  });

  it("reports an acceptance on a project that says a reviewer exists", () => {
    const warnings = checkReviewGate([workstream()], [pullRequest()], { operatingMode: "reviewed" });
    expect(codes(warnings)).toContain("OWNER_ACCEPTED_IN_REVIEWED_MODE");
  });

  it("treats that PR as unreviewed rather than just noting the contradiction", () => {
    // The finding would be decorative if the acceptance still opened the gate beside it. A merge
    // reported as unapproved is what proves it did not.
    const merged = pullRequest({ lifecycle: "MERGED", mergedAt: "2026-09-02T09:30:00Z" });
    const reported = codes(checkReviewGate([workstream()], [merged], { operatingMode: "reviewed" }));
    expect(reported).toContain("MERGED_WITHOUT_APPROVAL");
    expect(reported).toContain("OWNER_ACCEPTED_IN_REVIEWED_MODE");
    /**
     * ...and in a solo project neither finding appears, so it is the mode doing the work here
     * rather than anything about the record. (A phase/lifecycle mismatch remains in both — the
     * fixture is still in REVIEW with its PR merged — which is a different check entirely.)
     */
    const solo = codes(checkReviewGate([workstream()], [merged], SOLO));
    expect(solo).not.toContain("MERGED_WITHOUT_APPROVAL");
    expect(solo).not.toContain("OWNER_ACCEPTED_IN_REVIEWED_MODE");
  });

  it("defaults an undeclared project to reviewed, the stricter reading", () => {
    expect(codes(checkReviewGate([workstream()], [pullRequest()]))).toContain(
      "OWNER_ACCEPTED_IN_REVIEWED_MODE",
    );
  });

  it("keeps an outstanding objection closing the gate over an acceptance", () => {
    const pr = pullRequest({ changesRequestedBy: [{ actor: "reviewer", author: "50thycal" }] });
    expect(codes(checkReviewGate([workstream()], [pr], SOLO))).toContain(
      "WORKSTREAM_PR_STATE_MISMATCH",
    );
  });

  it("does not call finalization-before-verdict an error in solo mode", () => {
    /**
     * In `solo` the owner accepts at merge, so finalization legitimately precedes the verdict.
     * Reporting it would fire on every correctly run solo PR.
     */
    const ws = workstream({ reviewRecords: [record({ verdict: "IN_REVIEW", acceptedHead: undefined })] });
    expect(codes(checkReviewGate([ws], [pullRequest()], SOLO))).not.toContain(
      "WORKSTREAM_PR_STATE_MISMATCH",
    );
  });

  it("still reports finalization before approval in reviewed mode", () => {
    const ws = workstream({
      reviewRecords: [record({ verdict: "IN_REVIEW", acceptedHead: undefined })],
    });
    expect(codes(checkReviewGate([ws], [pullRequest()], { operatingMode: "reviewed" }))).toContain(
      "WORKSTREAM_PR_STATE_MISMATCH",
    );
  });

  it("lets a solo acceptance verify the head a finalization commit could not name", () => {
    const ws = workstream({ reviewRecords: [record({ acceptedHead: OTHER_HEAD, finalized: true })] });
    const pr = pullRequest({
      headSha: FINAL_HEAD,
      ownerAcceptances: [{ author: "50thycal", actor: "owner", head: FINAL_HEAD, at: "2026-09-02T08:00:00Z" }],
    });
    expect(checkReviewGate([ws], [pr], SOLO)).toEqual([]);
  });
});

describe("a verdict the pull request has never heard of", () => {
  it("reports a record whose PR carries no position at all", () => {
    /**
     * `DEC-023` made visible. A merge-finalization commit that pre-writes the verdict it expects
     * lands before that verdict exists, so the claim survives whether or not it ever arrives —
     * and from inside the file the two look identical.
     */
    const pr = pullRequest({ recordedPositions: 0, ownerAcceptances: [] });
    expect(codes(checkReviewGate([workstream()], [pr], SOLO))).toContain("VERDICT_UNSUPPORTED");
  });

  it("says nothing when a position exists but merely fails to clear the gate", () => {
    // A real approval that names no actor is still evidence a review happened. Calling the file's
    // claim a fabrication over that would be a serious accusation made on a technicality.
    const pr = pullRequest({ recordedPositions: 1, approvedHeadShas: [] });
    expect(codes(checkReviewGate([workstream()], [pr], SOLO))).not.toContain("VERDICT_UNSUPPORTED");
  });

  it("leaves a non-claiming record alone", () => {
    const ws = workstream({ reviewRecords: [record({ verdict: "IN_REVIEW", acceptedHead: undefined })] });
    const pr = pullRequest({ recordedPositions: 0, ownerAcceptances: [] });
    expect(codes(checkReviewGate([ws], [pr], SOLO))).not.toContain("VERDICT_UNSUPPORTED");
  });
});
