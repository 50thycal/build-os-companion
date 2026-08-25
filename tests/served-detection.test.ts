/**
 * Detection on the served path.
 *
 * The review gate reads two things a project declares about itself: which version of the
 * protocol it has adopted, and when. Until this, only `cli/sync.ts` ever ran detection, so a
 * Companion running as a server — which is how it is actually deployed — held neither. Every
 * headerless workstream fell back to "no pin recorded", and the gate stayed silent on exactly
 * the projects it was written for.
 *
 * These tests pin the served path specifically: a `durableSync` cycle detects, persists, and
 * carries the boundary across a restart.
 */

import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/store/database.ts";
import { CompanionStore } from "../src/store/store.ts";
import { SqliteEventLedger } from "../src/ledger/sqlite-ledger.ts";
import { durableSync } from "../src/sync/durable-sync.ts";
import type { GitHubPort, ObserveOptions, RepositoryFile } from "../src/ingest/github/client.ts";
import type { GitHubObservation } from "../src/ingest/github/types.ts";

const NOW = new Date("2026-08-24T12:00:00Z");
const OWNER = "50thycal";
const ADOPTED = "2026-08-20";

const CLAUDE_MD = [
  "# Agent instructions",
  "",
  "This project follows Build OS.",
  "",
  "Adopted version: v0.5",
  `Last compatibility check: v0.5 on ${ADOPTED}`,
].join("\n");

const ACTIVE_MD = [
  "# Active Work",
  "",
  "| ID | Title | Phase | Status | Next Step | PRs |",
  "|---|---|---|---|---|---|",
  "| WS-020 | Current work | REVIEW | Active | Await review | #31 |",
].join("\n");

/** No `Build OS:` header of its own — the project pin is the only thing that can gate it. */
const WS_020 = [
  "# WS-020 — Current work",
  "",
  "**Phase:** REVIEW · **Status:** Active",
  "**Updated:** 2026-08-23",
  "",
  "## Related PRs",
  "",
  "#31",
].join("\n");

/** One open PR, one headerless workstream, and agent instructions that declare the adoption. */
function repository(options: { agentInstructions?: string } = {}): GitHubPort {
  const files: Record<string, string | undefined> = {
    "CLAUDE.md": options.agentInstructions,
    "docs/workstreams/ACTIVE.md": ACTIVE_MD,
    "docs/workstreams/WS-020-current.md": WS_020,
  };

  return {
    async observe(_repo: string, _opts?: ObserveOptions): Promise<GitHubObservation> {
      return {
        repositoryFullName: "50thycal/cargo-ship",
        defaultBranch: "main",
        observedAt: NOW.toISOString(),
        pullRequests: [
          {
            number: 31,
            title: "Current work",
            author: OWNER,
            state: "open",
            draft: false,
            merged: false,
            createdAt: "2026-08-22T09:00:00Z",
            updatedAt: "2026-08-23T09:00:00Z",
            headSha: "f".repeat(40),
            baseRef: "main",
            headRef: "ws-020",
            htmlUrl: "https://github.com/50thycal/cargo-ship/pull/31",
            authorIsBot: false,
            requestedReviewers: [],
            reviews: [],
            checks: [],
          },
        ],
      };
    },

    async listPaths(_repo: string, directory: string): Promise<string[]> {
      return Object.keys(files).filter((p) => p.startsWith(`${directory}/`) && files[p]);
    },

    async readFile(_repo: string, path: string): Promise<RepositoryFile | undefined> {
      const content = files[path];
      if (content === undefined) return undefined;
      return {
        path,
        content,
        sha: `sha-${path}`,
        htmlUrl: `https://github.com/50thycal/cargo-ship/blob/main/${path}`,
      };
    },
  };
}

const PROJECT = {
  id: "proj_cargo_ship",
  ownerUserId: OWNER,
  repositoryFullName: "50thycal/cargo-ship",
  defaultBranch: "main",
  buildOsDetected: true,
  paths: {
    projectModel: "docs/PROJECT_MODEL.md",
    decisions: "docs/DECISIONS.md",
    activeWork: "docs/workstreams/ACTIVE.md",
    workstreamDir: "docs/workstreams",
  },
  enabled: true,
  createdAt: "2026-08-24T00:00:00Z",
};

function harness(location = ":memory:") {
  const db = openDatabase({ location });
  const store = new CompanionStore(db);
  const ledger = new SqliteEventLedger(db);
  store.upsertProject(PROJECT);
  return { db, store, ledger };
}

const cycle = (h: ReturnType<typeof harness>, github: GitHubPort, now = NOW) =>
  durableSync({
    store: h.store,
    ledger: h.ledger,
    github,
    project: h.store.getProject(PROJECT.id)!,
    ownerLogin: OWNER,
    now,
  });

describe("a served sync detects the project's adoption for itself", () => {
  it("persists the version and the adoption date the repository declares", async () => {
    const h = harness();
    await cycle(h, repository({ agentInstructions: CLAUDE_MD }));

    const stored = h.store.getProject(PROJECT.id)!;
    expect(stored.buildOsVersion).toBe("0.5");
    expect(stored.buildOsAdoptedAt).toBe(ADOPTED);
  });

  it("gates a headerless workstream that no CLI run ever pinned", async () => {
    const h = harness();
    const result = await cycle(h, repository({ agentInstructions: CLAUDE_MD }));

    const workstream = result.state.workstreams.find((w) => w.workstreamId === "WS-020");
    expect(workstream?.protocolVersion).toBe("0.5");
    expect(workstream?.protocolVersionSource).toBe("PROJECT");
    expect(result.state.integrityWarnings.map((w) => w.code)).toContain("REVIEW_RECORD_MISSING");
  });

  it("says nothing when the repository declares no version", async () => {
    // Silence is the correct output for a project that has not adopted: the gate is opt-in, and
    // an undeclared project must not be judged by it.
    const h = harness();
    const result = await cycle(h, repository());

    expect(h.store.getProject(PROJECT.id)!.buildOsVersion).toBeUndefined();
    expect(result.state.integrityWarnings.map((w) => w.code)).not.toContain(
      "REVIEW_RECORD_MISSING",
    );
  });

  it("carries the adoption boundary across a restart", async () => {
    const location = `/tmp/companion-detect-${process.pid}.db`;
    const first = harness(location);
    await cycle(first, repository({ agentInstructions: CLAUDE_MD }));
    first.db.close();

    // A second process opening the same file must find the boundary already there — before it
    // syncs. A boundary that only exists in memory would let every deploy re-accuse settled work
    // in the window before the first cycle finishes.
    const restarted = new CompanionStore(openDatabase({ location }));
    const stored = restarted.getProject(PROJECT.id)!;
    expect(stored.buildOsVersion).toBe("0.5");
    expect(stored.buildOsAdoptedAt).toBe(ADOPTED);
  });

  it("keeps the stored pin when a later cycle cannot read the instructions", async () => {
    // A missing CLAUDE.md is a failed read, not a renunciation. Forgetting the pin here would
    // silently switch the gate off for a project that has adopted.
    const h = harness();
    await cycle(h, repository({ agentInstructions: CLAUDE_MD }));
    await cycle(h, repository(), new Date("2026-08-24T13:00:00Z"));

    const stored = h.store.getProject(PROJECT.id)!;
    expect(stored.buildOsVersion).toBe("0.5");
    expect(stored.buildOsAdoptedAt).toBe(ADOPTED);
  });
});
