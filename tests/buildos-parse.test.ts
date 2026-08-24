import { describe, expect, it } from "vitest";

import {
  parseActiveBoard,
  parseDecisions,
  parseWorkstreamFile,
} from "../src/ingest/buildos/parse.ts";
import { detectBuildOs, workstreamFilePaths } from "../src/ingest/buildos/detect.ts";
import { DEFAULT_BUILD_OS_PATHS } from "../src/domain/state.ts";
import { fixtureText } from "./helpers.ts";

describe("ACTIVE.md parser", () => {
  const board = parseActiveBoard(fixtureText("build-os", "ACTIVE.md"));

  it("reads every well-formed row", () => {
    expect(board.rows.map((r) => r.workstreamId)).toEqual([
      "WS-001",
      "WS-002",
      "WS-003",
      "WS-004",
      "WS-007",
    ]);
  });

  it("reads phase, status, next step and related PRs", () => {
    const ws1 = board.rows.find((r) => r.workstreamId === "WS-001")!;
    expect(ws1.phase).toBe("BUILDING");
    expect(ws1.status).toBe("ACTIVE");
    expect(ws1.nextStep).toContain("Await PR");
    expect(ws1.relatedPrNumbers).toEqual([84]);
  });

  it("treats an em dash as absent rather than as a value", () => {
    const ws2 = board.rows.find((r) => r.workstreamId === "WS-002")!;
    expect(ws2.relatedPrNumbers).toEqual([]);
  });

  it("ignores the recently-completed table", () => {
    expect(board.rows.map((r) => r.workstreamId)).not.toContain("WS-005");
  });
});

describe("workstream file parser", () => {
  it("reads the standard sections", () => {
    const parsed = parseWorkstreamFile(fixtureText("build-os", "WS-001-procurement-redesign.md"));

    expect(parsed.headingWorkstreamId).toBe("WS-001");
    expect(parsed.title).toBe("Procurement redesign");
    expect(parsed.phase).toBe("BUILDING");
    expect(parsed.status).toBe("ACTIVE");
    expect(parsed.updatedAt).toBe("2026-08-18");
    expect(parsed.goal).toContain("decision players think about");
    expect(parsed.openDecisions).toEqual([]);
    expect(parsed.buildCardReady).toBe(true);
    expect(parsed.relatedPrNumbers).toEqual([84]);
    expect(parsed.relatedDecisionIds).toEqual(["DEC-016", "DEC-017"]);
  });

  it("extracts keyed open decisions", () => {
    const parsed = parseWorkstreamFile(fixtureText("build-os", "WS-002-construction-cards.md"));
    expect(parsed.openDecisions.map((d) => d.key)).toEqual(["D3", "D4"]);
    expect(parsed.openDecisions[0]!.question).toContain("return to the deck");
    expect(parsed.buildCardReady).toBe(false);
  });

  it("does not read a fenced code block as content", () => {
    const parsed = parseWorkstreamFile(fixtureText("build-os", "WS-001-procurement-redesign.md"));
    // The mental model fence contains "market row (6 slots)"; it must not leak into the goal.
    expect(parsed.goal).not.toContain("market row");
  });

  it("reports absence rather than guessing on a malformed file", () => {
    const parsed = parseWorkstreamFile(fixtureText("build-os", "WS-009-malformed.md"));
    expect(parsed.phase).toBeUndefined();
    expect(parsed.status).toBeUndefined();
    expect(parsed.goal).toBeUndefined();
    expect(parsed.openDecisions).toEqual([]);
    expect(parsed.buildCardReady).toBe(false);
  });
});

describe("DECISIONS.md parser", () => {
  const decisions = parseDecisions(fixtureText("build-os", "DECISIONS.md"));

  it("reads id, title, date and status", () => {
    const dec16 = decisions.find((d) => d.decisionId === "DEC-016")!;
    expect(dec16.title).toBe("Empty market slots refill at end of round");
    expect(dec16.date).toBe("2026-08-17");
    expect(dec16.status).toBe("ACCEPTED");
  });

  it("recognises supersession and keeps the pointer", () => {
    const dec18 = decisions.find((d) => d.decisionId === "DEC-018")!;
    expect(dec18.status).toBe("SUPERSEDED");
    expect(dec18.supersededBy).toBe("DEC-020");
  });

  it("keeps proposed decisions distinct from accepted ones", () => {
    expect(decisions.find((d) => d.decisionId === "DEC-019")!.status).toBe("PROPOSED");
  });
});

describe("build os detection", () => {
  it("detects from an adopted version in agent instructions", () => {
    const result = detectBuildOs({
      paths: [],
      agentInstructions: "## Build OS\n- Adopted version: v0.3\n",
    });
    expect(result.detected).toBe(true);
    expect(result.version).toBe("0.3");
  });

  it("reads the adoption date from the compatibility-check line", () => {
    const result = detectBuildOs({
      paths: [],
      agentInstructions:
        "## Build OS\n- Adopted version: v0.5\n- Last compatibility check: v0.5 on 2026-08-24\n",
    });
    expect(result.version).toBe("0.5");
    expect(result.adoptedAt).toBe("2026-08-24");
  });

  it("ignores a check line describing a version the project has not adopted", () => {
    // A stale line about v0.4 says nothing about when v0.5 arrived, and a wrong boundary would
    // either re-judge history or let current work through.
    const result = detectBuildOs({
      paths: [],
      agentInstructions:
        "## Build OS\n- Adopted version: v0.5\n- Last compatibility check: v0.4 on 2026-08-01\n",
    });
    expect(result.version).toBe("0.5");
    expect(result.adoptedAt).toBeUndefined();
  });

  it("detects from conventional paths with no instructions file", () => {
    const result = detectBuildOs({ paths: ["docs/workstreams/ACTIVE.md"] });
    expect(result.detected).toBe(true);
    expect(result.evidence).toContain("found docs/workstreams/ACTIVE.md");
  });

  it("honours overrides for a repository with its own convention", () => {
    const result = detectBuildOs({
      paths: ["process/board.md"],
      overrides: { activeWork: "process/board.md", workstreamDir: "process/threads" },
    });
    expect(result.detected).toBe(true);
    expect(result.paths.activeWork).toBe("process/board.md");
  });

  it("says so plainly when a repository does not use Build OS", () => {
    const result = detectBuildOs({ paths: ["README.md", "src/index.ts"] });
    expect(result.detected).toBe(false);
    expect(result.evidence).toContain("no Build OS artifacts or overrides found");
  });

  it("only picks up workstream-shaped filenames", () => {
    const paths = workstreamFilePaths(DEFAULT_BUILD_OS_PATHS, [
      "docs/workstreams/ACTIVE.md",
      "docs/workstreams/WS-001-thing.md",
      "docs/workstreams/notes.md",
      "docs/workstreams/nested/WS-002-other.md",
    ]);
    expect(paths).toEqual(["docs/workstreams/WS-001-thing.md"]);
  });
});
