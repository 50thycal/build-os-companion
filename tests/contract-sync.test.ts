/**
 * The vendored checkpoint schema must stay identical to the canonical one in build-os.
 *
 * The copy exists so this package stays self-contained and extractable (DEC-008). The cost of a
 * copy is drift, so the copy is checked rather than trusted — and the check skips itself once
 * the package no longer lives beside the protocol repository.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const vendored = join(here, "..", "src", "ingest", "checkpoint", "agent-session-checkpoint.v1.schema.json");
const canonical = join(here, "..", "..", "contracts", "agent-session-checkpoint.v1.schema.json");

describe("checkpoint contract", () => {
  it("matches the canonical Build OS contract while both are present", () => {
    if (!existsSync(canonical)) {
      // Extracted to its own repository. The vendored copy is now the only copy.
      expect(existsSync(vendored)).toBe(true);
      return;
    }
    expect(JSON.parse(readFileSync(vendored, "utf8"))).toEqual(
      JSON.parse(readFileSync(canonical, "utf8")),
    );
  });

  it("forbids additional properties, so a transcript field cannot be added by accident", () => {
    const schema = JSON.parse(readFileSync(vendored, "utf8"));
    expect(schema.additionalProperties).toBe(false);
  });

  it("excludes UNKNOWN from the status enum", () => {
    const schema = JSON.parse(readFileSync(vendored, "utf8"));
    expect(schema.properties.status.enum).not.toContain("UNKNOWN");
  });

  it("has no property whose name suggests conversation content", () => {
    const schema = JSON.parse(readFileSync(vendored, "utf8"));
    const forbidden = ["transcript", "messages", "conversation", "history", "log"];
    for (const name of Object.keys(schema.properties)) {
      expect(forbidden).not.toContain(name.toLowerCase());
    }
  });
});
