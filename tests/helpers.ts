import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { GitHubObservation } from "../src/ingest/github/types.ts";
import type { GitHubPort, ObserveOptions, RepositoryFile } from "../src/ingest/github/client.ts";
import { DEFAULT_BUILD_OS_PATHS, type FollowedProject } from "../src/domain/state.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(here, "..", "fixtures");

export function fixtureText(...segments: string[]): string {
  return readFileSync(join(FIXTURES, ...segments), "utf8");
}

export function fixtureJson<T>(...segments: string[]): T {
  return JSON.parse(fixtureText(...segments)) as T;
}

export function observation(cycle: 1 | 2): GitHubObservation {
  return fixtureJson<GitHubObservation>("github", `observation-cycle-${cycle}.json`);
}

export function buildOsSnapshotInput(observedAt = "2026-08-23T12:00:00Z") {
  const files = readdirSync(join(FIXTURES, "build-os"))
    .filter((name) => /^WS-\d{3}/.test(name))
    .sort()
    .map((name) => ({
      path: `docs/workstreams/${name}`,
      markdown: fixtureText("build-os", name),
      commitSha: "abc123",
      htmlUrl: `https://github.com/50thycal/cargo-ship/blob/main/docs/workstreams/${name}`,
    }));

  return {
    activeBoardPath: "docs/workstreams/ACTIVE.md",
    activeBoardMarkdown: fixtureText("build-os", "ACTIVE.md"),
    activeBoardCommitSha: "board123",
    activeBoardHtmlUrl:
      "https://github.com/50thycal/cargo-ship/blob/main/docs/workstreams/ACTIVE.md",
    workstreamFiles: files,
    observedAt,
  };
}

export function testProject(overrides: Partial<FollowedProject> = {}): FollowedProject {
  return {
    id: "proj_cargo_ship",
    ownerUserId: "user_1",
    repositoryFullName: "50thycal/cargo-ship",
    defaultBranch: "main",
    buildOsDetected: true,
    paths: DEFAULT_BUILD_OS_PATHS,
    enabled: true,
    createdAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

/** A GitHubPort backed by fixtures, so sync can be exercised with no network. */
export class FixtureGitHub implements GitHubPort {
  observeCalls = 0;

  constructor(
    private readonly observations: GitHubObservation[],
    private readonly failWith?: Error,
  ) {}

  async observe(_repo: string, _options?: ObserveOptions): Promise<GitHubObservation> {
    if (this.failWith) throw this.failWith;
    const index = Math.min(this.observeCalls, this.observations.length - 1);
    this.observeCalls += 1;
    return this.observations[index]!;
  }

  async listPaths(_repo: string, directory: string): Promise<string[]> {
    if (directory !== "docs/workstreams") return [];
    return readdirSync(join(FIXTURES, "build-os"))
      .filter((name) => /^WS-\d{3}/.test(name))
      .map((name) => `docs/workstreams/${name}`)
      .sort();
  }

  async readFile(_repo: string, path: string): Promise<RepositoryFile | undefined> {
    const name = path.split("/").pop()!;
    try {
      return {
        path,
        content: fixtureText("build-os", name),
        sha: "sha123",
        htmlUrl: `https://github.com/50thycal/cargo-ship/blob/main/${path}`,
      };
    } catch {
      return undefined;
    }
  }
}
