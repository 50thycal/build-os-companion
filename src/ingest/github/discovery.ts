/**
 * Which repositories the Companion follows.
 *
 * The first version of this application had no discovery at all: `companion.config.json` listed
 * two repositories and `applyConfig` disabled everything else, so the feed was narrow by
 * construction rather than by accident. A control surface for "my projects" cannot require the
 * owner to register each project by hand — the one thing they will forget to do is exactly the
 * thing that makes a project invisible.
 *
 * So eligibility is a rolling window over *attributable owner activity*, and the config file
 * drops back to what it is good at: pinning a repository the rule would not find, and carrying
 * per-repository overrides.
 *
 * The rule, in full:
 *
 * 1. Candidates are every repository the credentials can read — private included — whose
 *    `pushed_at` falls inside the window. Listing is paginated to exhaustion of the window; a
 *    truncated first page is not an eligibility rule, it is a bug.
 * 2. A candidate is *attributed* when the owner authored commits in the window, or authored or
 *    updated pull requests in it. Those are the two signals that mean "the owner worked here".
 * 3. `pushed_at` alone is a fallback, not a signal of ownership: it moves when a fork syncs
 *    upstream and when a bot pushes. It is enough for a plain, live repository and never enough
 *    for a fork or an archived one.
 * 4. Pins from the config file are always followed. Excludes are never followed, whatever the
 *    activity says.
 * 5. There is no cap. A portfolio is however large it is.
 *
 * Nothing here decides what "recently created" means, deliberately: a repository created inside
 * the window with no owner activity in it is not a project the owner is working on, and reading
 * creation as activity is the mistake that makes the feed look full and mean nothing.
 */

/** Why a repository is eligible, strongest first. Carried through to the UI as provenance. */
export type DiscoverySignal =
  | "OWNER_COMMITS"
  | "OWNER_PULL_REQUESTS"
  | "REPOSITORY_PUSH"
  | "PINNED";

export interface RepositorySummary {
  fullName: string;
  defaultBranch: string;
  /** ISO 8601. The last push to any branch, whoever made it. */
  pushedAt: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  description?: string;
}

/** Owner-attributable activity inside the window. Counts, because only presence matters. */
export interface OwnerActivity {
  commits: number;
  pullRequests: number;
}

export interface DiscoveredRepository {
  fullName: string;
  defaultBranch: string;
  pushedAt: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  signal: DiscoverySignal;
  /** True when a person — or an agent acting as them — is the reason this is here. */
  attributed: boolean;
  /** One sentence naming the evidence, for the provenance the owner can check. */
  evidence: string;
}

export interface DiscoveryPolicy {
  /** Rolling window, in days. */
  lookbackDays: number;
  /** Always followed, whatever the window says. `owner/name`. */
  pinned: string[];
  /** Never followed, whatever the window says. `owner/name`. */
  excluded: string[];
}

export const DEFAULT_DISCOVERY_POLICY: DiscoveryPolicy = {
  lookbackDays: 60,
  pinned: [],
  excluded: [],
};

export interface DiscoveryPort {
  /**
   * Every readable repository pushed at or after `pushedSince`, newest push first.
   *
   * The implementation paginates; this signature does not expose a page size because a caller
   * that can ask for one page can accidentally accept a truncated portfolio.
   */
  listRepositories(options: { pushedSince: string }): Promise<RepositorySummary[]>;
  /** Owner-attributable activity in `repositoryFullName` since `since`. */
  ownerActivity(
    repositoryFullName: string,
    ownerLogin: string,
    since: string,
  ): Promise<OwnerActivity>;
}

export interface DiscoveryInput {
  port: DiscoveryPort;
  ownerLogin: string;
  now: Date;
  policy?: Partial<DiscoveryPolicy>;
}

export interface DiscoveryResult {
  /** Everything that should be followed, most recently pushed first. */
  repositories: DiscoveredRepository[];
  /** The window's start, so the caller can report the rule it applied. */
  since: string;
  /** Candidates the rule rejected, and why. The owner is entitled to see the near misses. */
  rejected: { fullName: string; reason: string }[];
}

export function windowStart(now: Date, lookbackDays: number): string {
  return new Date(now.getTime() - lookbackDays * 86_400_000).toISOString();
}

function normalize(name: string): string {
  return name.toLowerCase();
}

/**
 * Apply the discovery rule.
 *
 * Pins are resolved first and never re-tested: a pinned repository the owner has not touched in
 * a year is still one they asked to see, and asking GitHub whether it qualifies would be asking
 * a question whose answer is not allowed to matter.
 */
export async function discoverRepositories(input: DiscoveryInput): Promise<DiscoveryResult> {
  const policy = { ...DEFAULT_DISCOVERY_POLICY, ...input.policy };
  const since = windowStart(input.now, policy.lookbackDays);
  const excluded = new Set(policy.excluded.map(normalize));
  const pinned = policy.pinned.filter((name) => !excluded.has(normalize(name)));
  const pinnedSet = new Set(pinned.map(normalize));

  const candidates = await input.port.listRepositories({ pushedSince: since });

  const repositories: DiscoveredRepository[] = [];
  const rejected: { fullName: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const repo of candidates) {
    const key = normalize(repo.fullName);
    if (seen.has(key)) continue;
    seen.add(key);

    if (excluded.has(key)) {
      rejected.push({ fullName: repo.fullName, reason: "excluded by configuration" });
      continue;
    }

    // A pinned repository is followed on the owner's say-so. Still listed here rather than
    // appended blind, so its real metadata (default branch, visibility) comes from GitHub.
    if (pinnedSet.has(key)) {
      repositories.push({
        ...toDiscovered(repo, "PINNED", true, "pinned in companion.config.json"),
      });
      continue;
    }

    if (repo.pushedAt < since) {
      rejected.push({
        fullName: repo.fullName,
        reason: `last pushed ${repo.pushedAt}, outside the ${policy.lookbackDays}-day window`,
      });
      continue;
    }

    const activity = await input.port.ownerActivity(repo.fullName, input.ownerLogin, since);

    if (activity.commits > 0) {
      repositories.push(
        toDiscovered(
          repo,
          "OWNER_COMMITS",
          true,
          `${activity.commits} commit${activity.commits === 1 ? "" : "s"} authored by ${input.ownerLogin} since ${since.slice(0, 10)}`,
        ),
      );
      continue;
    }

    if (activity.pullRequests > 0) {
      repositories.push(
        toDiscovered(
          repo,
          "OWNER_PULL_REQUESTS",
          true,
          `${activity.pullRequests} pull request${activity.pullRequests === 1 ? "" : "s"} authored by ${input.ownerLogin} and updated since ${since.slice(0, 10)}`,
        ),
      );
      continue;
    }

    // Nothing attributable. `pushed_at` is all that is left, and it is not enough to speak for
    // a fork (upstream syncs move it) or an archived repository (frozen work, not current work).
    if (repo.fork) {
      rejected.push({
        fullName: repo.fullName,
        reason: "a fork with no owner-authored commits or pull requests in the window",
      });
      continue;
    }
    if (repo.archived) {
      rejected.push({
        fullName: repo.fullName,
        reason: "archived, with no owner-authored activity in the window",
      });
      continue;
    }

    repositories.push(
      toDiscovered(
        repo,
        "REPOSITORY_PUSH",
        false,
        `pushed ${repo.pushedAt.slice(0, 10)}; no activity could be attributed to ${input.ownerLogin}`,
      ),
    );
  }

  // A pin GitHub did not list at all — a repository outside the window, which is the normal
  // reason to pin one. Followed on the owner's word, with the metadata left at its defaults.
  for (const name of pinned) {
    if (seen.has(normalize(name))) continue;
    repositories.push({
      fullName: name,
      defaultBranch: "main",
      pushedAt: since,
      private: false,
      fork: false,
      archived: false,
      signal: "PINNED",
      attributed: true,
      evidence: "pinned in companion.config.json; outside the activity window",
    });
  }

  repositories.sort((a, b) => b.pushedAt.localeCompare(a.pushedAt) || a.fullName.localeCompare(b.fullName));

  return { repositories, since, rejected };
}

function toDiscovered(
  repo: RepositorySummary,
  signal: DiscoverySignal,
  attributed: boolean,
  evidence: string,
): DiscoveredRepository {
  return {
    fullName: repo.fullName,
    defaultBranch: repo.defaultBranch,
    pushedAt: repo.pushedAt,
    private: repo.private,
    fork: repo.fork,
    archived: repo.archived,
    signal,
    attributed,
    evidence,
  };
}
