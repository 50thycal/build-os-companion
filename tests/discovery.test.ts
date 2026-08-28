/**
 * Repository discovery.
 *
 * The rule this suite pins is the answer to "why is my project not in the feed?", and every case
 * below came out of running the old code against a real account: it followed two repositories
 * because two repositories were typed into a file, and a portfolio of thirteen active ones was
 * invisible. The tests are therefore about *eligibility and its evidence*, not about counts.
 */

import { describe, expect, it } from "vitest";
import {
  discoverRepositories,
  windowStart,
  type DiscoveryPort,
  type OwnerActivity,
  type RepositorySummary,
} from "../src/ingest/github/discovery.ts";

const NOW = new Date("2026-08-28T12:00:00Z");
const OWNER = "50thycal";

function repo(overrides: Partial<RepositorySummary> & { fullName: string }): RepositorySummary {
  return {
    defaultBranch: "main",
    pushedAt: "2026-08-27T00:00:00Z",
    private: false,
    fork: false,
    archived: false,
    ...overrides,
  };
}

/** A port whose answers are declared up front, so a test states the world and nothing else. */
function port(
  repositories: RepositorySummary[],
  activity: Record<string, OwnerActivity> = {},
  calls?: { listed: number },
): DiscoveryPort {
  return {
    async listRepositories({ pushedSince }) {
      if (calls) calls.listed += 1;
      return repositories.filter((r) => r.pushedAt >= pushedSince);
    },
    async ownerActivity(fullName) {
      return activity[fullName] ?? { commits: 0, pullRequests: 0 };
    },
  };
}

const names = (result: { repositories: { fullName: string }[] }) =>
  result.repositories.map((r) => r.fullName);

describe("the sixty-day window", () => {
  it("follows a repository the owner has committed to inside it", async () => {
    const result = await discoverRepositories({
      port: port([repo({ fullName: "50thycal/kalshi_bot" })], {
        "50thycal/kalshi_bot": { commits: 12, pullRequests: 0 },
      }),
      ownerLogin: OWNER,
      now: NOW,
    });

    expect(names(result)).toEqual(["50thycal/kalshi_bot"]);
    expect(result.repositories[0]!.signal).toBe("OWNER_COMMITS");
    expect(result.repositories[0]!.attributed).toBe(true);
    expect(result.repositories[0]!.evidence).toContain("12 commits");
  });

  it("follows a repository where the owner's only activity is pull requests", async () => {
    const result = await discoverRepositories({
      port: port([repo({ fullName: "50thycal/workwiki", private: true })], {
        "50thycal/workwiki": { commits: 0, pullRequests: 3 },
      }),
      ownerLogin: OWNER,
      now: NOW,
    });

    expect(result.repositories[0]!.signal).toBe("OWNER_PULL_REQUESTS");
    // Private repositories are the owner's projects too, whenever the token can read them.
    expect(result.repositories[0]!.private).toBe(true);
  });

  it("drops a repository whose last push predates the window", async () => {
    const result = await discoverRepositories({
      port: port([repo({ fullName: "50thycal/battle_sim", pushedAt: "2026-02-24T00:00:00Z" })]),
      ownerLogin: OWNER,
      now: NOW,
    });

    expect(result.repositories).toEqual([]);
  });

  it("computes the window from the lookback, so the rule is one number", () => {
    expect(windowStart(NOW, 60)).toBe("2026-06-29T12:00:00.000Z");
    expect(windowStart(NOW, 7)).toBe("2026-08-21T12:00:00.000Z");
  });

  it("imposes no cap on how many projects a portfolio may have", async () => {
    const many = Array.from({ length: 40 }, (_, i) => repo({ fullName: `50thycal/p${i}` }));
    const result = await discoverRepositories({ port: port(many), ownerLogin: OWNER, now: NOW });
    expect(result.repositories).toHaveLength(40);
  });
});

describe("attribution outranks push time", () => {
  it("keeps a plain repository on push time alone, and says the attribution is missing", async () => {
    const result = await discoverRepositories({
      port: port([repo({ fullName: "50thycal/genX_life" })]),
      ownerLogin: OWNER,
      now: NOW,
    });

    expect(result.repositories[0]!.signal).toBe("REPOSITORY_PUSH");
    expect(result.repositories[0]!.attributed).toBe(false);
    expect(result.repositories[0]!.evidence).toContain("no activity could be attributed");
  });

  it("rejects a fork on push time alone, because an upstream sync moves that", async () => {
    const result = await discoverRepositories({
      port: port([repo({ fullName: "50thycal/zero", fork: true })]),
      ownerLogin: OWNER,
      now: NOW,
    });

    expect(result.repositories).toEqual([]);
    expect(result.rejected[0]!.reason).toContain("fork");
  });

  it("keeps a fork the owner is actually committing to", async () => {
    const result = await discoverRepositories({
      port: port([repo({ fullName: "50thycal/loop-engineering", fork: true })], {
        "50thycal/loop-engineering": { commits: 4, pullRequests: 0 },
      }),
      ownerLogin: OWNER,
      now: NOW,
    });

    expect(names(result)).toEqual(["50thycal/loop-engineering"]);
  });

  it("rejects an archived repository unless the owner has worked in it", async () => {
    const quiet = repo({ fullName: "50thycal/old", archived: true });
    const busy = repo({ fullName: "50thycal/revived", archived: true });

    const result = await discoverRepositories({
      port: port([quiet, busy], { "50thycal/revived": { commits: 1, pullRequests: 0 } }),
      ownerLogin: OWNER,
      now: NOW,
    });

    expect(names(result)).toEqual(["50thycal/revived"]);
    expect(result.rejected[0]!.reason).toContain("archived");
  });
});

describe("the owner's two exceptions", () => {
  it("follows a pin that is far outside the window", async () => {
    const result = await discoverRepositories({
      port: port([]),
      ownerLogin: OWNER,
      now: NOW,
      policy: { pinned: ["50thycal/townle"] },
    });

    expect(names(result)).toEqual(["50thycal/townle"]);
    expect(result.repositories[0]!.signal).toBe("PINNED");
  });

  it("marks a pin as pinned even when the window would have found it anyway", async () => {
    const result = await discoverRepositories({
      port: port([repo({ fullName: "50thycal/build-os" })], {
        "50thycal/build-os": { commits: 9, pullRequests: 0 },
      }),
      ownerLogin: OWNER,
      now: NOW,
      policy: { pinned: ["50thycal/build-os"] },
    });

    // The owner's word is the stronger claim, and it is what stops the project ageing out.
    expect(result.repositories[0]!.signal).toBe("PINNED");
  });

  it("never follows an exclusion, and an exclusion beats a pin", async () => {
    const result = await discoverRepositories({
      port: port([repo({ fullName: "50thycal/noisy" })], {
        "50thycal/noisy": { commits: 50, pullRequests: 0 },
      }),
      ownerLogin: OWNER,
      now: NOW,
      policy: { pinned: ["50thycal/noisy"], excluded: ["50thycal/noisy"] },
    });

    expect(result.repositories).toEqual([]);
  });

  it("follows a repository once, however many times the listing names it", async () => {
    // Affiliations overlap — owner and collaborator can both return the same repository — and a
    // portfolio that lists a project twice would sync it twice and show it twice.
    const calls = { listed: 0 };
    const result = await discoverRepositories({
      port: port([repo({ fullName: "50thycal/a" }), repo({ fullName: "50thycal/A" })], {}, calls),
      ownerLogin: OWNER,
      now: NOW,
    });
    expect(names(result)).toEqual(["50thycal/a"]);
    expect(calls.listed).toBe(1);
  });
});
