/**
 * Which projects the owner follows.
 *
 * A JSON file, not a database table the owner has no way to edit and not a hardcoded list they
 * would need a release to change. Adding a repository is adding a line; everything else —
 * where its Build OS artifacts live, whether it uses Build OS at all — is discovered, with
 * overrides available for the repositories that need them.
 */

import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_BUILD_OS_PATHS, type BuildOsPaths } from "../domain/state.ts";
import type { CompanionStore, StoredProject } from "../store/store.ts";

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

export interface CompanionConfig {
  /** The GitHub login that "waiting on you" means. */
  ownerLogin: string;
  projects: FollowedRepositoryConfig[];
}

/**
 * The repositories this application is for.
 *
 * Seeded rather than hardcoded: the file is what the application reads, and this is only what
 * it contains when nobody has written one.
 */
export const DEFAULT_CONFIG: CompanionConfig = {
  ownerLogin: "50thycal",
  projects: [{ repository: "50thycal/party-games" }, { repository: "50thycal/build-os" }],
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

  const projects = record.projects;
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

  return { ownerLogin: ownerLogin.trim(), projects: parsed };
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
 * Bring the store in line with the config file.
 *
 * Upsert, never replace. A repository dropped from the config keeps its rows — its history is
 * still true, and a typo in a config file should not be able to delete a month of events. It
 * simply stops being listed as followed.
 */
export function applyConfig(
  store: CompanionStore,
  config: CompanionConfig,
  now: Date,
): StoredProject[] {
  const configured = new Set<string>();

  for (const entry of config.projects) {
    const id = projectIdFor(entry.repository);
    configured.add(id);
    const existing = store.getProject(id);

    store.upsertProject({
      id,
      ownerUserId: config.ownerLogin,
      repositoryFullName: entry.repository,
      displayName: entry.displayName,
      defaultBranch: entry.defaultBranch ?? existing?.defaultBranch ?? "main",
      // Detection refines this on the first sync; assume Build OS until told otherwise, since
      // assuming otherwise means never looking.
      buildOsDetected: entry.buildOs ?? existing?.buildOsDetected ?? true,
      buildOsVersion: existing?.buildOsVersion,
      paths: { ...DEFAULT_BUILD_OS_PATHS, ...existing?.paths, ...entry.paths },
      enabled: entry.enabled ?? true,
      createdAt: existing?.createdAt ?? now.toISOString(),
      lastSyncedAt: existing?.lastSyncedAt,
      staleSince: existing?.staleSince,
    });
  }

  // Anything previously followed and no longer configured is disabled, not forgotten.
  for (const project of store.listProjects()) {
    if (!configured.has(project.id)) {
      store.upsertProject({ ...project, enabled: false });
    }
  }

  return store.listProjects();
}
