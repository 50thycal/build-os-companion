import { describe, expect, it } from "vitest";

import { reconcileBuildOsState } from "../src/ingest/buildos/reconcile.ts";
import { normalizeWorkstreams } from "../src/ingest/buildos/normalize.ts";
import { InMemoryEventLedger } from "../src/ledger/ledger.ts";
import { buildOsSnapshotInput } from "./helpers.ts";

const PROJECT = "proj_cargo_ship";
const reconciled = reconcileBuildOsState(PROJECT, buildOsSnapshotInput());
const byId = new Map(reconciled.workstreams.map((w) => [w.workstreamId, w]));

describe("board and workstream file reconciliation", () => {
  it("materializes one state per workstream file", () => {
    expect([...byId.keys()]).toEqual([
      "WS-001",
      "WS-002",
      "WS-003",
      "WS-004",
      "WS-006",
      "WS-008",
      "WS-009",
    ]);
  });

  it("prefers the workstream file when it disagrees with the board", () => {
    // The board says WS-003 is EXPLORE; the file says MODEL.
    expect(byId.get("WS-003")!.phase).toBe("MODEL");

    const warning = reconciled.warnings.find((w) => w.code === "BOARD_FILE_PHASE_MISMATCH");
    expect(warning?.workstreamId).toBe("WS-003");
    expect(warning?.message).toContain("Using the workstream file");
  });

  it("records the mismatch as a conflict with both sources, not a silent merge", () => {
    const conflict = reconciled.conflicts.find((c) => c.field.includes("WS-003"));
    expect(conflict).toBeDefined();
    expect(conflict!.winner.source.sourceId).toContain("WS-003");
    expect(conflict!.losers[0]!.source.sourceId).toBe("docs/workstreams/ACTIVE.md");
  });

  it("warns about active work that is missing from the board", () => {
    const codes = reconciled.warnings
      .filter((w) => w.code === "WORKSTREAM_MISSING_FROM_BOARD")
      .map((w) => w.workstreamId);
    expect(codes).toContain("WS-006");
    expect(codes).toContain("WS-008");
  });

  it("warns about a board row with no file behind it", () => {
    const orphans = reconciled.warnings
      .filter((w) => w.code === "BOARD_ROW_WITHOUT_FILE")
      .map((w) => w.workstreamId);
    expect(orphans).toEqual(["WS-007"]);
  });

  it("keeps parsing after meeting a malformed file", () => {
    const malformed = byId.get("WS-009")!;
    expect(malformed.phase).toBeUndefined();
    expect(malformed.status).toBeUndefined();
    // Addressed by filename, so it still exists as a workstream.
    expect(malformed.workstreamId).toBe("WS-009");
    expect(byId.get("WS-001")!.phase).toBe("BUILDING");
  });

  it("reads a blocker from BLOCKED status plus next step", () => {
    const blocked = byId.get("WS-006")!;
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.blocker).toContain("prize-payout rules");
  });

  it("does not treat a paused workstream as blocked", () => {
    const paused = byId.get("WS-004")!;
    expect(paused.status).toBe("PAUSED");
    expect(paused.blocker).toBeUndefined();
  });

  it("unions related PRs from the board and the file", () => {
    expect(byId.get("WS-001")!.relatedPrNumbers).toEqual([84]);
    expect(byId.get("WS-008")!.relatedPrNumbers).toEqual([91]);
  });
});

describe("workstream event normalization", () => {
  it("announces every workstream once on first sight", () => {
    const ledger = new InMemoryEventLedger();
    const first = ledger.append(
      normalizeWorkstreams(reconciled.workstreams, { projectId: PROJECT }),
    );
    expect(first.appended.every((e) => e.eventType === "WORKSTREAM_CREATED")).toBe(true);
    expect(first.appended).toHaveLength(reconciled.workstreams.length);

    const previous = new Map(reconciled.workstreams.map((w) => [w.workstreamId, w]));
    const second = ledger.append(
      normalizeWorkstreams(reconciled.workstreams, { projectId: PROJECT, previous }),
    );
    expect(second.appended).toHaveLength(0);
  });

  it("emits a phase change only when the phase actually moved", () => {
    const previous = new Map(
      reconciled.workstreams.map((w) => [
        w.workstreamId,
        w.workstreamId === "WS-001" ? { ...w, phase: "READY_TO_BUILD" as const } : w,
      ]),
    );
    const drafts = normalizeWorkstreams(reconciled.workstreams, {
      projectId: PROJECT,
      previous,
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.eventType).toBe("WORKSTREAM_PHASE_CHANGED");
    expect(drafts[0]!.summaryShort).toContain("READY_TO_BUILD to BUILDING");
  });

  it("emits a blocked event when a workstream becomes blocked", () => {
    const previous = new Map(
      reconciled.workstreams.map((w) => [
        w.workstreamId,
        w.workstreamId === "WS-006" ? { ...w, status: "ACTIVE" as const } : w,
      ]),
    );
    const drafts = normalizeWorkstreams(reconciled.workstreams, { projectId: PROJECT, previous });
    const blocked = drafts.find((d) => d.eventType === "WORKSTREAM_BLOCKED");
    expect(blocked?.workstreamId).toBe("WS-006");
    expect(blocked?.summaryShort).toContain("prize-payout rules");
  });
});

describe("v0.5 review-field warnings", () => {
  function reconcileOne(reviewSection: string) {
    const base = buildOsSnapshotInput();
    const input = {
      ...base,
      activeBoardMarkdown: `# Active Work

| ID | Title | Phase | Status | Next Step | PRs |
|---|---|---|---|---|---|
| WS-011 | Review gate | REVIEW | Active | Await review | #84 |
`,
      workstreamFiles: [
        {
          path: "docs/workstreams/WS-011-review-gate.md",
          markdown: `# WS-011 — Review gate

**Phase:** REVIEW · **Status:** Active

## Review State

${reviewSection}

## Related PRs

#84
`,
          commitSha: "abc123",
          htmlUrl: "https://github.com/50thycal/cargo-ship/blob/main/docs/workstreams/WS-011-review-gate.md",
        },
      ],
    };
    return reconcileBuildOsState(PROJECT, input);
  }

  it("carries verdict and reviewed head onto workstream state", () => {
    const head = "0123456789abcdef0123456789abcdef01234567";
    const ws = reconcileOne(`**Verdict:** Approved\n**Reviewed head:** ${head}`).workstreams[0]!;
    expect(ws.reviewRecords).toEqual([
      { prNumber: 84, verdict: "APPROVED", reviewedHead: head, finalized: false },
    ]);
  });

  it("binds a record that names no PR to the workstream's most recent linked PR", () => {
    // #84 is the only linked PR here; with several, the record binds to the newest rather than
    // to all of them, which is what stopped older merged PRs being reported as unapproved.
    const ws = reconcileOne("**Verdict:** In review").workstreams[0]!;
    expect(ws.reviewRecords[0]!.prNumber).toBe(84);
  });

  it("keeps a per-PR review table as one record per PR", () => {
    const head = "0123456789abcdef0123456789abcdef01234567";
    const other = "89abcdef0123456789abcdef0123456789abcdef";
    const ws = reconcileOne(
      [
        "| PR | Verdict | Reviewed head | Finalization |",
        "|---|---|---|---|",
        `| #84 | Approved | ${head} | pushed |`,
        `| #91 | Changes required | ${other} | — |`,
      ].join("\n"),
    ).workstreams[0]!;
    expect(ws.reviewRecords).toEqual([
      { prNumber: 84, verdict: "APPROVED", reviewedHead: head, finalized: true },
      { prNumber: 91, verdict: "CHANGES_REQUIRED", reviewedHead: other, finalized: false },
    ]);
  });

  it("warns when an approval names no commit, and does not treat it as approved evidence", () => {
    const result = reconcileOne("**Verdict:** Approved\n**Reviewed head:** —");
    expect(result.warnings.map((w) => w.code)).toContain("APPROVED_WITHOUT_REVIEWED_HEAD");
    expect(result.workstreams[0]!.reviewRecords[0]!.reviewedHead).toBeUndefined();
  });

  it("warns on a verdict outside the allowed set and leaves the field absent", () => {
    const result = reconcileOne("**Verdict:** Looks good");
    expect(result.warnings.map((w) => w.code)).toContain("REVIEW_VERDICT_MALFORMED");
    expect(result.workstreams[0]!.reviewRecords[0]?.verdict).toBeUndefined();
  });

  it("warns on an abbreviated reviewed head", () => {
    const result = reconcileOne("**Verdict:** In review\n**Reviewed head:** 0123456");
    expect(result.warnings.map((w) => w.code)).toContain("REVIEWED_HEAD_MALFORMED");
    expect(result.workstreams[0]!.reviewRecords[0]!.reviewedHead).toBeUndefined();
  });

  it("says nothing about a pre-v0.5 workstream with a prose review section", () => {
    const result = reconcileOne("Not started.");
    const reviewCodes = result.warnings
      .map((w) => w.code)
      .filter((c) => c.startsWith("REVIEW") || c.startsWith("APPROVED"));
    expect(reviewCodes).toEqual([]);
    expect(result.workstreams[0]!.reviewRecords).toEqual([]);
  });
});

describe("v0.5 participation metadata", () => {
  function reconcileWith(header: string, buildOsVersion?: string) {
    const base = buildOsSnapshotInput();
    return reconcileBuildOsState(PROJECT, {
      ...base,
      buildOsVersion,
      activeBoardMarkdown: [
        "# Active Work",
        "",
        "| ID | Title | Phase | Status | Next Step | PRs |",
        "|---|---|---|---|---|---|",
        "| WS-012 | Gate metadata | REVIEW | Active | Await review | #84 |",
      ].join("\n"),
      workstreamFiles: [
        {
          path: "docs/workstreams/WS-012-gate-metadata.md",
          markdown: `# WS-012 — Gate metadata\n\n${header}\n\n## Related PRs\n\n#84\n`,
          commitSha: "abc123",
          htmlUrl: "https://github.com/50thycal/cargo-ship/blob/main/docs/workstreams/WS-012.md",
        },
      ],
    }).workstreams[0]!;
  }

  it("reads a version the workstream declares for itself", () => {
    const ws = reconcileWith("**Phase:** REVIEW · **Status:** Active · **Build OS:** v0.5");
    expect(ws.protocolVersion).toBe("v0.5");
  });

  it("falls back to the project's adopted version", () => {
    const ws = reconcileWith("**Phase:** REVIEW · **Status:** Active", "v0.5");
    expect(ws.protocolVersion).toBe("v0.5");
  });

  it("prefers the workstream's own declaration over the project pin", () => {
    const ws = reconcileWith("**Phase:** REVIEW · **Status:** Active · **Build OS:** v0.4", "v0.5");
    expect(ws.protocolVersion).toBe("v0.4");
    expect(ws.protocolVersionSource).toBe("WORKSTREAM");
  });

  it("records that an inherited version came from the project, not the file", () => {
    // The distinction the gate needs: a pin the project holds is not a claim that this
    // workstream's history was done under it.
    const ws = reconcileWith("**Phase:** REVIEW · **Status:** Active", "v0.5");
    expect(ws.protocolVersionSource).toBe("PROJECT");
  });

  it("leaves it absent when neither declares one", () => {
    expect(reconcileWith("**Phase:** REVIEW · **Status:** Active").protocolVersion).toBeUndefined();
  });
});
