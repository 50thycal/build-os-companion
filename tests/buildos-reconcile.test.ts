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
