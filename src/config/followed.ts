/**
 * Which projects the owner follows.
 *
 * This file used to *be* the answer: a hand-written list of two repositories, with everything
 * absent from it disabled. That made the feed narrow by construction — the owner's portfolio was
 * whatever they had last remembered to type — and it is the defect this module now exists to not
 * have. Eligibility comes from `discoverRepositories`: a rolling window over attributable owner
 * activity, run against GitHub on every sync.
 *
 * What remains here is the two things a rule cannot know. A **pin** is a repository the owner
 * wants followed whatever the window says, and an **override** says where a repository keeps its
 * Build OS artifacts, or that it has none. Both are exceptions to discovery, never the source of
 * it, and a config file that lists nothing at all is now a working configuration.
 */

import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_BUILD_OS_PATHS, type BuildOsPaths } from "../domain/state.ts";
import type { CompanionStore, StoredProject } from "../store/store.ts";
import type { DiscoveredRepository, DiscoverySignal } from "../ingest/github/discovery.ts";

export interface FollowedRepositoryConfig {
  /** `owner/name`. The only required field. */
  repository: string;
  /** Shown in the UI instead of the repository name. */
  displayName?: string;
  defaultBranch?: string;
  /**
   * Where this repository keeps its Build OS artifacts, when it does not keep them where
   * detection would find them. Overrides always win over discovery.
   */
  paths?: Partial<BuildOsPaths>;
  /** Force Build OS handling on or off. Omit to let detection decide. */
  buildOs?: boolean;
  /** Follow the repository but stop syncing it, without losing its history. */
  enabled?: boolean;
}

/** How wide the Companion casts its net, and the two exceptions to the rule. */
export interface DiscoveryConfig {
  /** Turn automatic discovery off and follow only the pinned projects. Defaults to on. */
  enabled: boolean;
  /** The rolling activity window, in days. */
  lookbackDays: number;
  /** `owner/name` entries discovery must never follow, whatever their activity says. */
  exclude: string[];
}

export const DEFAULT_DISCOVERY: DiscoveryConfig = {
  enabled: true,
  lookbackDays: 60,
  exclude: [],
};

export interface CompanionConfig {
  /** The GitHub login that "waiting on you" means. */
  ownerLogin: string;
  /**
   * Repositories pinned by the owner, plus per-repository overrides. Not an allowlist: a
   * repository absent from here is still followed when discovery finds recent owner activity in
   * it, and an entry here only ever *adds* — it pins, renames, or redirects a path.
   */
  projects: FollowedRepositoryConfig[];
  discovery: DiscoveryConfig;
}

/**
 * The repositories this application is for.
 *
 * Seeded rather than hardcoded: the file is what the application reads, and this is only what
 * it contains when nobody has written one.
 */
export const DEFAULT_CONFIG: CompanionConfig = {
  ownerLogin: "50thycal",
  // No pins. The portfolio is whatever the owner has been working in, which is the point.
  projects: [],
  discovery: DEFAULT_DISCOVERY,
};

/** `owner/name` -> a stable project id. Slashes are not safe in URLs or element ids. */
export function projectIdFor(repository: string): string {
  return repository.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase();
}

export class ConfigError extends Error {}

const REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export function parseConfig(raw: unknown): CompanionConfig {
  if (typeof raw !== "object" || raw === null) throw new ConfigError("config must be an object");
  const record = raw as Record<string, unknown>;

  const ownerLogin = record.ownerLogin;
  if (typeof ownerLogin !== "string" || ownerLogin.trim() === "") {
    throw new ConfigError("config.ownerLogin is required: it decides what 'waiting on you' means");
  }

  const projects = record.projects ?? [];
  if (!Array.isArray(projects)) throw new ConfigError("config.projects must be an array");

  const seen = new Set<string>();
  const parsed = projects.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new ConfigError(`config.projects[${index}] must be an object`);
    }
    const project = entry as Record<string, unknown>;
    const repository = project.repository;
    if (typeof repository !== "string" || !REPOSITORY.test(repository)) {
      throw new ConfigError(`config.projects[${index}].repository must look like "owner/name"`);
    }
    if (seen.has(repository)) throw new ConfigError(`config lists ${repository} more than once`);
    seen.add(repository);

    return {
      repository,
      displayName: typeof project.displayName === "string" ? project.displayName : undefined,
      defaultBranch: typeof project.defaultBranch === "string" ? project.defaultBranch : undefined,
      paths: (project.paths as Partial<BuildOsPaths> | undefined) ?? undefined,
      buildOs: typeof project.buildOs === "boolean" ? project.buildOs : undefined,
      enabled: typeof project.enabled === "boolean" ? project.enabled : undefined,
    } satisfies FollowedRepositoryConfig;
  });

  return { ownerLogin: ownerLogin.trim(), projects: parsed, discovery: parseDiscovery(record.discovery) };
}

function parseDiscovery(raw: unknown): DiscoveryConfig {
  if (raw === undefined || raw === null) return DEFAULT_DISCOVERY;
  if (typeof raw !== "object") throw new ConfigError("config.discovery must be an object");
  const record = raw as Record<string, unknown>;

  const lookbackDays = record.lookbackDays;
  if (lookbackDays !== undefined && (typeof lookbackDays !== "number" || !Number.isFinite(lookbackDays) || lookbackDays <= 0)) {
    throw new ConfigError("config.discovery.lookbackDays must be a positive number of days");
  }

  const exclude = record.exclude ?? [];
  if (!Array.isArray(exclude) || exclude.some((entry) => typeof entry !== "string" || !REPOSITORY.test(entry))) {
    throw new ConfigError('config.discovery.exclude must be a list of "owner/name" strings');
  }

  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : DEFAULT_DISCOVERY.enabled,
    lookbackDays: (lookbackDays as number | undefined) ?? DEFAULT_DISCOVERY.lookbackDays,
    exclude: exclude as string[],
  };
}

/** Read the config file, falling back to the seed when there is none. */
export function loadConfig(path: string): CompanionConfig {
  if (!existsSync(path)) return DEFAULT_CONFIG;
  try {
    return parseConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
}

/**
 * Bring the store in line with the config file *and* with what discovery found.
 *
 * Upsert, never replace, in both directions. A repository that leaves the window keeps every row
 * it ever had — its history is still true, and a rolling rule must not be able to delete a month
 * of events by being applied on a quiet Tuesday. It simply stops being synced and stops being
 * listed.
 *
 * Ageing out only happens when discovery actually ran. A failed listing is not evidence that the
 * owner stopped working: on a discovery failure the previously followed set is left exactly as
 * it was, which is the same promise `syncProject` already makes about a failed poll.
 */
export function applyConfig(
  store: CompanionStore,
  config: CompanionConfig,
  now: Date,
  options: ApplyConfigOptions = {},
): StoredProject[] {
  const timestamp = now.toISOString();
  const overrides = new Map(config.projects.map((entry) => [projectIdFor(entry.repository), entry]));
  const followed = new Set<string>();

  const upsert = (
    repository: string,
    defaults: { defaultBranch?: string; displayName?: string },
    provenance: { signal: DiscoverySignal; evidence: string },
  ): void => {
    const id = projectIdFor(repository);
    if (followed.has(id)) return;
    followed.add(id);

    const entry = overrides.get(id);
    const existing = store.getProject(id);

    store.upsertProject({
      id,
      ownerUserId: config.ownerLogin,
      repositoryFullName: repository,
      displayName: entry?.displayName ?? defaults.displayName ?? existing?.displayName,
      defaultBranch: entry?.defaultBranch ?? defaults.defaultBranch ?? existing?.defaultBranch ?? "main",
      // Detection refines this on the first sync; assume Build OS until told otherwise, since
      // assuming otherwise means never looking. A repository without it degrades to a
      // GitHub-only project rather than disappearing.
      buildOsDetected: entry?.buildOs ?? existing?.buildOsDetected ?? true,
      buildOsVersion: existing?.buildOsVersion,
      buildOsAdoptedAt: existing?.buildOsAdoptedAt,
      paths: { ...DEFAULT_BUILD_OS_PATHS, ...existing?.paths, ...entry?.paths },
      enabled: entry?.enabled ?? true,
      createdAt: existing?.createdAt ?? timestamp,
      lastSyncedAt: existing?.lastSyncedAt,
      staleSince: existing?.staleSince,
      lastError: existing?.lastError,
      discoverySignal: provenance.signal,
      discoveryEvidence: provenance.evidence,
      discoveredAt: existing?.discoveredAt ?? timestamp,
    });
  };

  // Pins first, so a repository the owner named keeps `PINNED` provenance even when discovery
  // would also have found it. The owner's word is the stronger claim and the one that stops it
  // ageing out.
  for (const entry of config.projects) {
    upsert(entry.repository, {}, { signal: "PINNED", evidence: "pinned in companion.config.json" });
  }

  for (const repo of options.discovered ?? []) {
    upsert(
      repo.fullName,
      { defaultBranch: repo.defaultBranch },
      { signal: repo.signal, evidence: repo.evidence },
    );
  }

  for (const project of store.listProjects({ includeDisabled: true })) {
    if (followed.has(project.id)) continue;
    if (!project.enabled) continue;
    // Nothing ages out on a cycle where discovery could not speak. Only a de-pinned project,
    // which the config file said explicitly, is disabled without discovery's evidence.
    const dePinned = project.discoverySignal === "PINNED" || project.discoverySignal === undefined;
    if (!options.discoveryRan && !dePinned) continue;
    store.upsertProject({ ...project, enabled: false });
  }

  return store.listProjects();
}

export interface ApplyConfigOptions {
  /** What the discovery rule found this cycle. */
  discovered?: DiscoveredRepository[];
  /**
   * Whether discovery ran and answered. False — the default — means a project missing from
   * `discovered` is missing because nothing looked, not because it aged out.
   */
  discoveryRan?: boolean;
}
