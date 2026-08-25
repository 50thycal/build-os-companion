import { describe, expect, it } from "vitest";

import { checkReviewGate } from "../src/projection/review-gate.ts";
import { reconcileBuildOsState } from "../src/ingest/buildos/reconcile.ts";
import type {
  IntegrityWarning,
  PullRequestState,
  ReviewRecord,
  WorkstreamState,
} from "../src/domain/state.ts";
import type { SourceRef } from "../src/domain/provenance.ts";

const APPROVED_HEAD = "1111111111111111111111111111111111111111";
const CURRENT_HEAD = "2222222222222222222222222222222222222222";
const FINAL_HEAD = "3333333333333333333333333333333333333333";
const MERGED_HEAD = "4444444444444444444444444444444444444444";

const SOURCE: SourceRef = {
  sourceType: "BUILD_OS_ARTIFACT",
  sourceId: "docs/workstreams/WS-011.md",
  sourceUrl: "https://github.com/50thycal/cargo-ship/blob/main/docs/workstreams/WS-011.md",
  observedAt: "2026-08-23T18:00:00Z",
};

const PR_SOURCE: SourceRef = {
  sourceType: "GITHUB_STATE",
  sourceId: "pr:84",
  sourceUrl: "https://github.com/50thycal/cargo-ship/pull/84",
  observedAt: "2026-08-23T18:00:00Z",
};

function record(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    prNumber: 84,
    verdict: "APPROVED",
    reviewedHead: APPROVED_HEAD,
    finalized: false,
    ...overrides,
  };
}

function workstream(overrides: Partial<WorkstreamState> = {}): WorkstreamState {
  return {
    projectId: "proj_cargo_ship",
    workstreamId: "WS-011",
    title: "Review gate",
    phase: "REVIEW",
    status: "ACTIVE",
    openDecisions: [],
    relatedPrNumbers: [84],
    relatedDecisionIds: [],
    buildCardReady: true,
    reviewRecords: [record()],
    sourcePath: "docs/workstreams/WS-011.md",
    source: SOURCE,
    conflicts: [],
    ...overrides,
  };
}

function pullRequest(overrides: Partial<PullRequestState> = {}): PullRequestState {
  return {
    projectId: "proj_cargo_ship",
    number: 84,
    title: "Region-aware simulation",
    lifecycle: "OPEN",
    draft: false,
    headBranch: "claude/regions",
    headSha: APPROVED_HEAD,
    baseBranch: "main",
    author: "50thycal",
    createdAt: "2026-08-21T09:00:00Z",
    updatedAt: "2026-08-23T17:00:00Z",
    mergeability: "CLEAN",
    reviewState: "APPROVED",
    ciState: "PASSED",
    requestedReviewers: [],
    approvedHeadShas: [],
    changesRequestedBy: [],
    workstreamIds: ["WS-011"],
    sourceUrl: "https://github.com/50thycal/cargo-ship/pull/84",
    source: PR_SOURCE,
    ...overrides,
  };
}

const codes = (warnings: IntegrityWarning[]) => warnings.map((w) => w.code);

describe("REVIEW_STALE", () => {
  it("fires when the PR head moved past the approved head", () => {
    const warnings = checkReviewGate([workstream()], [pullRequest({ headSha: CURRENT_HEAD })]);
    expect(codes(warnings)).toEqual(["REVIEW_STALE"]);
    expect(warnings[0]!.message).toContain("1111111");
    expect(warnings[0]!.message).toContain("2222222");
  });

  it("stays quiet while the approved head is still the head", () => {
    expect(checkReviewGate([workstream()], [pullRequest()])).toEqual([]);
  });

  it("treats approved-with-follow-ups exactly like approved", () => {
    const ws = workstream({ reviewRecords: [record({ verdict: "APPROVED_WITH_FOLLOW_UPS" })] });
    expect(checkReviewGate([ws], [pullRequest()])).toEqual([]);
    expect(codes(checkReviewGate([ws], [pullRequest({ headSha: CURRENT_HEAD })]))).toEqual([
      "REVIEW_STALE",
    ]);
  });

  it("does not fire on an approval that names no head — that is a different warning", () => {
    // APPROVED_WITHOUT_REVIEWED_HEAD is raised at reconcile time, from the workstream alone.
    const ws = workstream({ reviewRecords: [record({ reviewedHead: undefined })] });
    expect(checkReviewGate([ws], [pullRequest({ headSha: CURRENT_HEAD })])).toEqual([]);
  });

  it("still reports the file's stale record even when GitHub approved the current head", () => {
    // GitHub evidence does not repair a durable record that is behind. It clears exactly one
    // thing — the finalization head the file could not name — and nothing else.
    const pr = pullRequest({ headSha: CURRENT_HEAD, approvedHeadShas: [CURRENT_HEAD] });
    expect(codes(checkReviewGate([workstream()], [pr]))).toEqual(["REVIEW_STALE"]);
  });
});

describe("merge finalization — the head a commit cannot name", () => {
  // The finalization commit changes the head by existing, so no SHA inside it can be the head
  // it produces. The file records the last fully-reviewed head and says finalization is pushed.
  const finalized = () => workstream({ reviewRecords: [record({ finalized: true })] });

  it("does not call a finalized PR stale — the divergence is expected", () => {
    const warnings = checkReviewGate([finalized()], [pullRequest({ headSha: FINAL_HEAD })]);
    expect(codes(warnings)).not.toContain("REVIEW_STALE");
  });

  it("asks for the final head to be verified on the PR instead", () => {
    const warnings = checkReviewGate([finalized()], [pullRequest({ headSha: FINAL_HEAD })]);
    expect(codes(warnings)).toEqual(["FINAL_HEAD_UNVERIFIED"]);
    expect(warnings[0]!.message).toContain("3333333");
    expect(warnings[0]!.message).toContain("1111111");
  });

  it("goes quiet once a current approving review names the final head", () => {
    const pr = pullRequest({ headSha: FINAL_HEAD, approvedHeadShas: [APPROVED_HEAD, FINAL_HEAD] });
    expect(checkReviewGate([finalized()], [pr])).toEqual([]);
  });

  it("does not clear on a final-head approval while a changes request is outstanding", () => {
    const pr = pullRequest({
      headSha: FINAL_HEAD,
      approvedHeadShas: [FINAL_HEAD],
      changesRequestedBy: ["sam"],
    });
    expect(codes(checkReviewGate([finalized()], [pr]))).toContain("FINAL_HEAD_UNVERIFIED");
  });

  it("does not clear on a workstream record that is not itself approving", () => {
    // Finalization is only reachable from an approved record. A file saying `In review` with a
    // GitHub approval on the head is a contradiction, not a shortcut through the gate.
    const ws = workstream({
      reviewRecords: [record({ verdict: "IN_REVIEW", finalized: true })],
    });
    const pr = pullRequest({ headSha: FINAL_HEAD, approvedHeadShas: [FINAL_HEAD] });
    expect(checkReviewGate([ws], [pr])).not.toEqual([]);
  });

  it("still reports a merge at a head nobody verified", () => {
    const ws = workstream({ phase: "COMPLETE", status: "COMPLETE" });
    const pr = pullRequest({ lifecycle: "MERGED", headSha: MERGED_HEAD });
    expect(codes(checkReviewGate([ws], [pr]))).toEqual(["MERGED_WITHOUT_APPROVAL"]);
  });
});

describe("MERGED_WITHOUT_APPROVAL", () => {
  it("fires when a merged PR's record never approved", () => {
    const ws = workstream({
      phase: "BUILDING",
      reviewRecords: [record({ verdict: "IN_REVIEW", reviewedHead: undefined })],
    });
    const warnings = checkReviewGate([ws], [pullRequest({ lifecycle: "MERGED" })]);
    expect(codes(warnings)).toEqual(["MERGED_WITHOUT_APPROVAL"]);
    expect(warnings[0]!.message).toContain("IN_REVIEW");
  });

  it("fires when the merged commit is not the approved commit", () => {
    const ws = workstream({ phase: "COMPLETE", status: "COMPLETE" });
    const warnings = checkReviewGate(
      [ws],
      [pullRequest({ lifecycle: "MERGED", headSha: CURRENT_HEAD })],
    );
    expect(codes(warnings)).toEqual(["MERGED_WITHOUT_APPROVAL"]);
  });

  it("stays quiet when the merged commit is the approved commit", () => {
    const ws = workstream({ phase: "COMPLETE", status: "COMPLETE" });
    expect(checkReviewGate([ws], [pullRequest({ lifecycle: "MERGED" })])).toEqual([]);
  });

  it("exempts a workstream written before v0.5, which records nothing at all", () => {
    const ws = workstream({ reviewRecords: [], phase: "COMPLETE", status: "COMPLETE" });
    expect(checkReviewGate([ws], [pullRequest({ lifecycle: "MERGED" })])).toEqual([]);
  });

  it("does not fire on a closed-unmerged PR", () => {
    const ws = workstream({
      phase: "BUILDING",
      reviewRecords: [record({ verdict: "CHANGES_REQUIRED", reviewedHead: undefined })],
    });
    expect(checkReviewGate([ws], [pullRequest({ lifecycle: "CLOSED" })])).toEqual([]);
  });
});

describe("a workstream spanning several PRs", () => {
  // The regression: one workstream-level reviewed head compared against every linked PR. The
  // moment #91 was approved, #84 — merged weeks earlier at its own approved head — was reported
  // as merged without approval.
  const merged = () =>
    pullRequest({ number: 84, lifecycle: "MERGED", headSha: MERGED_HEAD, source: PR_SOURCE });
  const open = () =>
    pullRequest({
      number: 91,
      lifecycle: "OPEN",
      headSha: CURRENT_HEAD,
      source: { ...PR_SOURCE, sourceId: "pr:91" },
    });

  const spanning = (records: ReviewRecord[]) =>
    workstream({ phase: "REVIEW", relatedPrNumbers: [84, 91], reviewRecords: records });

  it("does not report an older merged PR because a newer one was approved", () => {
    const ws = spanning([
      record({ prNumber: 84, reviewedHead: MERGED_HEAD }),
      record({ prNumber: 91, reviewedHead: CURRENT_HEAD }),
    ]);
    expect(checkReviewGate([ws], [merged(), open()])).toEqual([]);
  });

  it("says nothing about a linked PR that has no record", () => {
    const ws = spanning([record({ prNumber: 91, reviewedHead: CURRENT_HEAD })]);
    expect(checkReviewGate([ws], [merged(), open()])).toEqual([]);
  });

  it("still reports the specific PR whose own record is contradicted", () => {
    const ws = spanning([
      record({ prNumber: 84, reviewedHead: APPROVED_HEAD }),
      record({ prNumber: 91, reviewedHead: CURRENT_HEAD }),
    ]);
    const warnings = checkReviewGate([ws], [merged(), open()]);
    expect(codes(warnings)).toEqual(["MERGED_WITHOUT_APPROVAL"]);
    expect(warnings[0]!.message).toContain("#84");
  });

  it("reports a stale head on the open PR without touching the merged one", () => {
    const ws = spanning([
      record({ prNumber: 84, reviewedHead: MERGED_HEAD }),
      record({ prNumber: 91, reviewedHead: APPROVED_HEAD }),
    ]);
    const warnings = checkReviewGate([ws], [merged(), open()]);
    expect(codes(warnings)).toEqual(["REVIEW_STALE"]);
    expect(warnings[0]!.message).toContain("#91");
  });

  it("allows a workstream to stay active after one of its PRs merges", () => {
    const ws = spanning([record({ prNumber: 91, reviewedHead: CURRENT_HEAD })]);
    expect(checkReviewGate([{ ...ws, phase: "BUILDING" }], [merged(), open()])).toEqual([]);
  });
});

describe("WORKSTREAM_PR_STATE_MISMATCH", () => {
  it("fires when a workstream is still in REVIEW after its PRs settled", () => {
    const ws = workstream({ reviewRecords: [] });
    const warnings = checkReviewGate([ws], [pullRequest({ lifecycle: "MERGED" })]);
    expect(codes(warnings)).toEqual(["WORKSTREAM_PR_STATE_MISMATCH"]);
    expect(warnings[0]!.message).toContain("finalization");
  });

  it("fires when a workstream claims COMPLETE while a PR is still open", () => {
    const ws = workstream({ phase: "COMPLETE", status: "COMPLETE", reviewRecords: [] });
    expect(
      codes(checkReviewGate([ws], [pullRequest({ lifecycle: "DRAFT", draft: true })])),
    ).toEqual(["WORKSTREAM_PR_STATE_MISMATCH"]);
  });

  it("says nothing about a workstream with no linked PR", () => {
    const ws = workstream({ relatedPrNumbers: [], reviewRecords: [] });
    expect(checkReviewGate([ws], [pullRequest()])).toEqual([]);
  });

  it("carries both sources so the owner can open either side", () => {
    const ws = workstream({ reviewRecords: [] });
    const warnings = checkReviewGate([ws], [pullRequest({ lifecycle: "MERGED" })]);
    expect(warnings[0]!.sources.map((s) => s.sourceType)).toEqual([
      "BUILD_OS_ARTIFACT",
      "GITHUB_STATE",
    ]);
  });
});

describe("GitHub review currency", () => {
  // A gate that reads the historical union of approvals can be opened by a verdict its own
  // reviewer has already withdrawn.
  const finalized = (overrides: Partial<ReviewRecord> = {}) =>
    workstream({ reviewRecords: [record({ finalized: true, ...overrides })] });

  it("does not treat an approval the same reviewer later retracted as evidence", () => {
    // rae approved FINAL_HEAD, then requested changes on it. deriveApprovedHeadShas no longer
    // reports the superseded approval, and changesRequestedBy keeps the gate closed either way.
    const pr = pullRequest({
      headSha: FINAL_HEAD,
      approvedHeadShas: [],
      changesRequestedBy: ["rae"],
    });
    const warnings = codes(checkReviewGate([finalized()], [pr]));
    expect(warnings).toContain("FINAL_HEAD_UNVERIFIED");
    // And the retraction itself is surfaced, rather than the gate simply going quiet.
    expect(warnings).toContain("WORKSTREAM_PR_STATE_MISMATCH");
  });

  it("does not let one reviewer's approval erase another's outstanding objection", () => {
    const pr = pullRequest({
      headSha: FINAL_HEAD,
      approvedHeadShas: [FINAL_HEAD],
      changesRequestedBy: ["sam"],
    });
    expect(codes(checkReviewGate([finalized()], [pr]))).toContain("FINAL_HEAD_UNVERIFIED");
  });

  it("reports the contradiction when GitHub objects to work the workstream calls approved", () => {
    const pr = pullRequest({ changesRequestedBy: ["sam"] });
    const warnings = checkReviewGate([workstream()], [pr]);
    expect(codes(warnings)).toContain("WORKSTREAM_PR_STATE_MISMATCH");
    expect(warnings[0]!.message).toContain("sam");
  });

  it("does not let a current-head GitHub approval override a workstream Changes required", () => {
    const ws = workstream({
      phase: "BUILDING",
      reviewRecords: [record({ verdict: "CHANGES_REQUIRED", reviewedHead: undefined })],
    });
    const pr = pullRequest({ lifecycle: "MERGED", approvedHeadShas: [APPROVED_HEAD] });
    expect(codes(checkReviewGate([ws], [pr]))).toContain("MERGED_WITHOUT_APPROVAL");
  });

  it("clears final-head verification once the current position is approving and unopposed", () => {
    const pr = pullRequest({
      headSha: FINAL_HEAD,
      approvedHeadShas: [FINAL_HEAD],
      changesRequestedBy: [],
    });
    expect(checkReviewGate([finalized()], [pr])).toEqual([]);
  });
});

describe("v0.5 participation is declared, not inferred", () => {
  // Absence of a review record must not be what makes a workstream look legacy — otherwise the
  // gate is opt-out by deleting one table row.
  // A workstream that declares v0.5 in its own `Build OS:` header.
  const v05 = (overrides: Partial<WorkstreamState> = {}) =>
    workstream({
      protocolVersion: "v0.5",
      protocolVersionSource: "WORKSTREAM",
      reviewRecords: [],
      ...overrides,
    });

  it("stays silent on a genuine pre-v0.5 workstream with no record", () => {
    const ws = workstream({ reviewRecords: [], phase: "COMPLETE", status: "COMPLETE" });
    expect(ws.protocolVersion).toBeUndefined();
    expect(checkReviewGate([ws], [pullRequest({ lifecycle: "MERGED" })])).toEqual([]);
  });

  it("stays silent on a v0.4 workstream, whatever its phase", () => {
    const ws = v05({ protocolVersion: "v0.4", phase: "COMPLETE", status: "COMPLETE" });
    expect(checkReviewGate([ws], [pullRequest({ lifecycle: "MERGED" })])).toEqual([]);
  });

  it("reports a v0.5 significant workstream with no record while the PR is open", () => {
    const warnings = checkReviewGate([v05()], [pullRequest()]);
    expect(codes(warnings)).toContain("REVIEW_RECORD_MISSING");
    expect(warnings[0]!.message).toContain("#84");
  });

  it("reports a v0.5 significant workstream whose PR merged with no record", () => {
    const ws = v05({ phase: "COMPLETE", status: "COMPLETE" });
    expect(codes(checkReviewGate([ws], [pullRequest({ lifecycle: "MERGED" })]))).toEqual([
      "MERGED_WITHOUT_APPROVAL",
    ]);
  });

  it("cannot be silenced by deleting the review record", () => {
    const withRecord = workstream({ protocolVersion: "v0.5" });
    const stale = pullRequest({ headSha: CURRENT_HEAD });
    expect(codes(checkReviewGate([withRecord], [stale]))).toEqual(["REVIEW_STALE"]);

    // Same workstream, record removed. The warning changes; it does not disappear.
    const deleted = { ...withRecord, reviewRecords: [] };
    expect(codes(checkReviewGate([deleted], [stale]))).toEqual(["REVIEW_RECORD_MISSING"]);
  });

  it("applies to any version from v0.5 onward", () => {
    const ws = v05({ protocolVersion: "v0.6" });
    expect(codes(checkReviewGate([ws], [pullRequest()]))).toContain("REVIEW_RECORD_MISSING");
  });

  it("says nothing about a v0.5 workstream that has not reached a Build Card", () => {
    const ws = v05({ phase: "EXPLORE", buildCardReady: false });
    expect(checkReviewGate([ws], [pullRequest()])).toEqual([]);
  });
});

describe("adoption never reaches backwards", () => {
  // A project upgrading to v0.5 must not thereby claim that every headerless workstream it
  // inherits was done under v0.5. Completed history stays exempt; current work does not.
  const ADOPTED = "2026-08-20";

  /** A workstream with no `Build OS:` header, carrying the project's pin by inheritance. */
  const inherited = (overrides: Partial<WorkstreamState> = {}) =>
    workstream({
      protocolVersion: "v0.5",
      protocolVersionSource: "PROJECT",
      reviewRecords: [],
      ...overrides,
    });

  const legacyPr = (overrides: Partial<PullRequestState> = {}) =>
    pullRequest({ lifecycle: "MERGED", createdAt: "2026-07-01T09:00:00Z", ...overrides });

  it("says nothing about a completed pre-v0.5 workstream whose PR already merged", () => {
    const ws = inherited({ phase: "COMPLETE", status: "COMPLETE" });
    expect(checkReviewGate([ws], [legacyPr()], { adoptedAt: ADOPTED })).toEqual([]);
  });

  it("says nothing about an active workstream last touched before adoption", () => {
    const ws = inherited({ phase: "BUILDING", updatedAt: "2026-08-01" });
    expect(checkReviewGate([ws], [legacyPr()], { adoptedAt: ADOPTED })).toEqual([]);
  });

  it("stays quiet on settled work when the project records no adoption date", () => {
    // Without a boundary there is no way to tell pre- from post-adoption, and the safe answer
    // for something already merged is silence.
    const ws = inherited({ phase: "BUILDING" });
    expect(checkReviewGate([ws], [legacyPr()])).toEqual([]);
  });

  it("leaves an older merged PR alone while covering the current one", () => {
    // The round-1 multi-PR false positive, re-entered through the participation model.
    const ws = inherited({
      phase: "REVIEW",
      updatedAt: "2026-08-23",
      relatedPrNumbers: [84, 91],
      reviewRecords: [record({ prNumber: 91, reviewedHead: CURRENT_HEAD })],
    });
    const open = pullRequest({
      number: 91,
      lifecycle: "OPEN",
      headSha: CURRENT_HEAD,
      createdAt: "2026-08-22T09:00:00Z",
      source: { ...PR_SOURCE, sourceId: "pr:91" },
    });
    expect(checkReviewGate([ws], [legacyPr(), open], { adoptedAt: ADOPTED })).toEqual([]);
  });

  it("covers a current significant PR opened after adoption", () => {
    const ws = inherited({ phase: "REVIEW", updatedAt: "2026-08-23" });
    const pr = pullRequest({ createdAt: "2026-08-22T09:00:00Z" });
    expect(codes(checkReviewGate([ws], [pr], { adoptedAt: ADOPTED }))).toEqual([
      "REVIEW_RECORD_MISSING",
    ]);
  });

  it("covers a PR merged after adoption", () => {
    const ws = inherited({ phase: "REVIEW", updatedAt: "2026-08-23" });
    const pr = pullRequest({ lifecycle: "MERGED", createdAt: "2026-08-22T09:00:00Z" });
    expect(codes(checkReviewGate([ws], [pr], { adoptedAt: ADOPTED }))).toContain(
      "MERGED_WITHOUT_APPROVAL",
    );
  });

  it("cannot be silenced by deleting the current PR's record", () => {
    const base = inherited({ phase: "REVIEW", updatedAt: "2026-08-23" });
    const pr = pullRequest({ headSha: CURRENT_HEAD, createdAt: "2026-08-22T09:00:00Z" });

    const withRecord = { ...base, reviewRecords: [record()] };
    expect(codes(checkReviewGate([withRecord], [pr], { adoptedAt: ADOPTED }))).toEqual([
      "REVIEW_STALE",
    ]);
    expect(codes(checkReviewGate([base], [pr], { adoptedAt: ADOPTED }))).toEqual([
      "REVIEW_RECORD_MISSING",
    ]);
  });

  it("honours a workstream's own v0.4 header over a v0.5 project pin", () => {
    const ws = workstream({
      protocolVersion: "v0.4",
      protocolVersionSource: "WORKSTREAM",
      reviewRecords: [],
      phase: "REVIEW",
      updatedAt: "2026-08-23",
    });
    const pr = pullRequest({ createdAt: "2026-08-22T09:00:00Z" });
    expect(checkReviewGate([ws], [pr], { adoptedAt: ADOPTED })).toEqual([]);
  });

  it("covers a completed workstream that declares v0.5 itself", () => {
    // A declaration is a statement about this workstream, so it holds even once complete.
    const ws = workstream({
      protocolVersion: "v0.5",
      protocolVersionSource: "WORKSTREAM",
      reviewRecords: [],
      phase: "COMPLETE",
      status: "COMPLETE",
    });
    expect(
      codes(checkReviewGate([ws], [pullRequest({ lifecycle: "MERGED" })], { adoptedAt: ADOPTED })),
    ).toEqual(["MERGED_WITHOUT_APPROVAL"]);
  });
});

describe("end to end — a project upgrading to v0.5", () => {
  // The regression as it actually reached the repository: the project pin was copied onto every
  // headerless workstream at reconcile time, so adopting v0.5 condemned finished v0.4 work.
  const ADOPTED = "2026-08-20";

  function reconcileOne(markdown: string, boardRow: string) {
    return reconcileBuildOsState("proj_cargo_ship", {
      activeBoardPath: "docs/workstreams/ACTIVE.md",
      activeBoardMarkdown: [
        "# Active Work",
        "",
        "| ID | Title | Phase | Status | Next Step | PRs |",
        "|---|---|---|---|---|---|",
        boardRow,
      ].join("\n"),
      workstreamFiles: [
        {
          path: "docs/workstreams/WS-011-legacy.md",
          markdown,
          commitSha: "abc123",
          htmlUrl: "https://github.com/50thycal/cargo-ship/blob/main/docs/workstreams/WS-011.md",
        },
      ],
      observedAt: "2026-08-24T12:00:00Z",
      buildOsVersion: "v0.5",
      buildOsAdoptedAt: ADOPTED,
    }).workstreams;
  }

  const legacyMerged = pullRequest({
    lifecycle: "MERGED",
    createdAt: "2026-07-01T09:00:00Z",
    headSha: MERGED_HEAD,
  });

  it("leaves a completed v0.4 workstream alone after the project adopts v0.5", () => {
    const workstreams = reconcileOne(
      `# WS-011 — Legacy work\n\n**Phase:** COMPLETE · **Status:** Complete\n**Updated:** 2026-07-15\n\n## Review State\n\nReviewed 2026-07-14. No findings.\n\n## Related PRs\n\n#84\n`,
      "| WS-011 | Legacy work | COMPLETE | Complete | None | #84 |",
    );
    expect(workstreams[0]!.protocolVersion).toBe("v0.5");
    expect(workstreams[0]!.protocolVersionSource).toBe("PROJECT");
    expect(checkReviewGate(workstreams, [legacyMerged], { adoptedAt: ADOPTED })).toEqual([]);
  });

  it("covers current work on the same project", () => {
    const workstreams = reconcileOne(
      `# WS-011 — Current work\n\n**Phase:** REVIEW · **Status:** Active\n**Updated:** 2026-08-23\n\n## Related PRs\n\n#84\n`,
      "| WS-011 | Current work | REVIEW | Active | Await review | #84 |",
    );
    const current = pullRequest({ createdAt: "2026-08-22T09:00:00Z" });
    expect(codes(checkReviewGate(workstreams, [current], { adoptedAt: ADOPTED }))).toEqual([
      "REVIEW_RECORD_MISSING",
    ]);
  });
});
