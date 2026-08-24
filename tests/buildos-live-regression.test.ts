/**
 * Regressions found by parsing the real Build OS artifacts in `50thycal/party-games`.
 *
 * The bundled fixtures under `fixtures/build-os/` were written by hand and, without anyone
 * intending it, wrote every bullet and every prose field on a single line. Real artifacts are
 * hard-wrapped at ~100 columns. Everything below failed against the real files on 2026-08-24
 * while the 120 existing tests passed.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { listItems } from "../src/ingest/buildos/markdown.ts";
import { parseActiveBoard, parseWorkstreamFile } from "../src/ingest/buildos/parse.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "build-os", "live");
const workstream = readFileSync(join(fixtures, "WS-001-party-games-excerpt.md"), "utf8");
const board = readFileSync(join(fixtures, "ACTIVE-party-games.md"), "utf8");

describe("hard-wrapped list items", () => {
  it("keeps a bullet that spans several lines whole", () => {
    const items = listItems(
      [
        "- **D1. Shelving.** A company may leave a contract off the schedule entirely and eat its",
        "  incomplete penalty (−4 to −8 VP). Introduced because a company forced above the horizon",
        "  would otherwise have *no* legal schedule.",
        "- **D2.** A second, separate decision.",
      ].join("\n"),
    );

    expect(items).toHaveLength(2);
    expect(items[0]).toContain("incomplete penalty");
    expect(items[0]).toContain("legal schedule");
    // The bug: the item ended at the first line break, mid-clause, with no sign of truncation.
    expect(items[0]).not.toMatch(/eat its$/);
  });

  it("ends an item at a blank line, a heading, or a table rather than running on", () => {
    const items = listItems(
      ["- first item", "  wrapped on", "", "loose paragraph", "- second item", "## Heading", "still not part of it"].join("\n"),
    );

    expect(items).toEqual(["first item wrapped on", "second item"]);
  });

  it("collapses the wrapping instead of preserving newlines inside an item", () => {
    const [only] = listItems("- one\n  two\n  three");
    expect(only).toBe("one two three");
  });
});

describe("the real WS-001 workstream file", () => {
  const parsed = parseWorkstreamFile(workstream);

  it("reads the header block", () => {
    expect(parsed.phase).toBe("REVIEW");
    expect(parsed.status).toBe("ACTIVE");
    expect(parsed.updatedAt).toBe("2026-08-23");
  });

  it("finds all eight open decisions", () => {
    expect(parsed.openDecisions.map((d) => d.key)).toEqual([
      "D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8",
    ]);
  });

  it("gives every decision a question that ends on a sentence boundary", () => {
    for (const decision of parsed.openDecisions) {
      expect(decision.question.length).toBeGreaterThan(20);
      expect(decision.question).toMatch(/[.?!]$/);
    }
  });

  it("keeps the full entry in detail when the question is only its opening", () => {
    const d1 = parsed.openDecisions.find((d) => d.key === "D1")!;
    expect(d1.question).toContain("Shelving.");
    expect(d1.detail).toBeDefined();
    expect(d1.detail!.length).toBeGreaterThan(d1.question.length);
    // Nothing the artifact said is dropped: the options and the recommendation survive.
    expect(d1.detail).toContain("Recommendation:");
  });

  it("renders Next Step as one line, not with the file's wrapping baked in", () => {
    expect(parsed.nextStep).toBeDefined();
    expect(parsed.nextStep).not.toContain("\n");
    expect(parsed.nextStep).toContain("owner ruling on D1–D4");
  });
});

describe("the real ACTIVE.md board", () => {
  const parsed = parseActiveBoard(board);

  it("reads both workstreams with no skipped rows", () => {
    expect(parsed.rows.map((r) => r.workstreamId)).toEqual(["WS-001", "WS-002"]);
    expect(parsed.skippedRows).toBe(0);
  });

  it("accepts title-case status as written in the real board", () => {
    expect(parsed.rows.every((r) => r.status === "ACTIVE")).toBe(true);
    expect(parsed.rows.every((r) => r.phase === "REVIEW")).toBe(true);
  });

  it("extracts PR numbers from markdown links without picking up URL digits", () => {
    expect(parsed.rows[0]!.relatedPrNumbers).toEqual([137, 139]);
    expect(parsed.rows[1]!.relatedPrNumbers).toEqual([141]);
  });
});
