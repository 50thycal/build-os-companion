/**
 * Vendored Build OS contracts must not drift.
 *
 * `50thycal/build-os` is canonical (DEC-008). The Companion vendors contracts so it can parse
 * offline and test deterministically, and the cost of a copy is drift — so the copy is checked
 * rather than trusted.
 *
 * This test is the *offline* half: it proves the vendored file still matches the hash recorded
 * in `contracts/MANIFEST.json`, and that the copy `src/` actually loads is byte-identical to it.
 * That catches a local edit. It deliberately does not reach the network, because a build must
 * not fail when GitHub is unreachable — `npm run contracts:check` is the half that catches
 * upstream moving, and it runs in CI.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "contracts", "MANIFEST.json"), "utf8")) as {
  canonicalRepository: string;
  contracts: { file: string; canonicalPath: string; sha256: string; consumedBy?: string }[];
};

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("vendored Build OS contracts", () => {
  it("names build-os as the canonical source", () => {
    expect(manifest.canonicalRepository).toBe("50thycal/build-os");
    expect(manifest.contracts.length).toBeGreaterThan(0);
  });

  for (const contract of manifest.contracts) {
    it(`${contract.file} matches its recorded hash`, () => {
      const vendored = readFileSync(join(root, "contracts", contract.file), "utf8");
      expect(sha256(vendored)).toBe(contract.sha256);
    });

    // Some contracts are loaded straight from `contracts/`; only those with a second copy
    // inside `src/` need the two kept identical.
    const consumedBy = contract.consumedBy;
    if (consumedBy) {
      it(`${contract.file} is byte-identical to the copy src/ loads`, () => {
        const vendored = readFileSync(join(root, "contracts", contract.file), "utf8");
        const consumed = readFileSync(join(root, consumedBy), "utf8");
        expect(consumed).toBe(vendored);
      });
    }
  }
});

describe("checkpoint schema shape", () => {
  const schema = JSON.parse(
    readFileSync(join(root, "src", "ingest", "checkpoint", "agent-session-checkpoint.v1.schema.json"), "utf8"),
  );

  it("forbids additional properties, so a transcript field cannot be added by accident", () => {
    expect(schema.additionalProperties).toBe(false);
  });

  it("excludes UNKNOWN from the status enum", () => {
    expect(schema.properties.status.enum).not.toContain("UNKNOWN");
  });

  it("has no property whose name suggests conversation content", () => {
    const forbidden = ["transcript", "messages", "conversation", "history", "log"];
    for (const name of Object.keys(schema.properties)) {
      expect(forbidden).not.toContain(name.toLowerCase());
    }
  });
});
