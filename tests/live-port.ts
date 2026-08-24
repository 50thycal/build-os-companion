/**
 * A `GitHubPort` backed by recorded live data.
 *
 * The pull-request payloads and the Build OS artifacts under the `live` fixture directories were recorded
 * from `50thycal/party-games` on 2026-08-24. Serving them through the real port interface runs
 * the entire pipeline — normalize, ledger, project, attention, feed — over data the owner's own
 * repository actually produced, which is the part of "live sync" that hand-written fixtures
 * could not check.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { GitHubPort, ObserveOptions, RepositoryFile } from "../src/ingest/github/client.ts";
import type { GitHubObservation, GitHubPullRequestObservation } from "../src/ingest/github/types.ts";

const root = dirname(fileURLToPath(import.meta.url));
const githubLive = join(root, "..", "fixtures", "github", "live");
const buildOsLive = join(root, "..", "fixtures", "build-os", "live");

const listPayload = JSON.parse(readFileSync(join(githubLive, "pulls-list-merged.json"), "utf8"))
  .payload as Record<string, never>[];

/** The real artifacts, mapped onto the paths party-games actually uses. */
const FILES: Record<string, string> = {
  "docs/workstreams/ACTIVE.md": join(buildOsLive, "ACTIVE-party-games.md"),
  "docs/workstreams/WS-001-subway-v0-3-redesign.md": join(buildOsLive, "WS-001-party-games-excerpt.md"),
  "docs/workstreams/WS-002-subway-route-engineering.md": join(buildOsLive, "WS-002-subway-route-engineering.md"),
  "docs/DECISIONS.md": join(buildOsLive, "DECISIONS-party-games-excerpt.md"),
};

function toObservation(raw: Record<string, never>): GitHubPullRequestObservation {
  const head = raw.head as unknown as { ref: string };
  const user = raw.user as unknown as { login: string; type?: string };
  return {
    number: raw.number as unknown as number,
    title: raw.title as unknown as string,
    state: raw.state as unknown as "open" | "closed",
    draft: Boolean(raw.draft),
    merged: Boolean(raw.merged_at),
    createdAt: raw.created_at as unknown as string,
    updatedAt: raw.updated_at as unknown as string,
    mergedAt: (raw.merged_at as unknown as string) ?? undefined,
    closedAt: (raw.closed_at as unknown as string) ?? undefined,
    headRef: head.ref,
    baseRef: (raw.base as unknown as { ref: string }).ref,
    author: user.login,
    authorIsBot: false,
    authorIsAgent: /^(claude|codex)\//i.test(head.ref),
    htmlUrl: raw.html_url as unknown as string,
    // Every open PR observed came back `unknown`, and party-games runs no CI at all.
    mergeableState: "unknown",
    requestedReviewers: [],
    reviews: [],
    checks: [],
  };
}

export interface LivePortOptions {
  /** Override individual PR observations, to simulate a later poll cycle. */
  transform?: (pr: GitHubPullRequestObservation) => GitHubPullRequestObservation;
  observedAt?: string;
  /** Throw on observe, to exercise the sync-failure path. */
  failWith?: Error;
}

export function livePartyGamesPort(options: LivePortOptions = {}): GitHubPort {
  return {
    async observe(_repo: string, opts: ObserveOptions = {}): Promise<GitHubObservation> {
      if (options.failWith) throw options.failWith;
      const pullRequests = listPayload
        .map(toObservation)
        .filter((pr) => !opts.updatedSince || pr.updatedAt > opts.updatedSince)
        .map((pr) => (options.transform ? options.transform(pr) : pr));

      return {
        repositoryFullName: "50thycal/party-games",
        defaultBranch: "main",
        observedAt: options.observedAt ?? "2026-08-24T12:00:00Z",
        pullRequests,
      };
    },

    async listPaths(_repo: string, directory: string): Promise<string[]> {
      return Object.keys(FILES).filter((p) => p.startsWith(`${directory}/`));
    },

    async readFile(_repo: string, path: string): Promise<RepositoryFile | undefined> {
      const file = FILES[path];
      if (!file) return undefined;
      return {
        path,
        content: readFileSync(file, "utf8"),
        sha: `sha-${path}`,
        htmlUrl: `https://github.com/50thycal/party-games/blob/main/${path}`,
      };
    },
  };
}

export const PARTY_GAMES = {
  id: "party-games",
  ownerUserId: "50thycal",
  repositoryFullName: "50thycal/party-games",
  defaultBranch: "main",
  buildOsDetected: true,
  buildOsVersion: "0.4",
  paths: {
    projectModel: "docs/PROJECT_MODEL.md",
    decisions: "docs/DECISIONS.md",
    activeWork: "docs/workstreams/ACTIVE.md",
    workstreamDir: "docs/workstreams",
  },
  enabled: true,
  createdAt: "2026-08-24T00:00:00Z",
};
