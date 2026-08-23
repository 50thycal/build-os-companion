/**
 * Detect whether a followed repository uses Build OS, and where its artifacts live.
 *
 * The parse contract forbids requiring the conventional paths: Build OS explicitly permits
 * repository-specific documentation conventions. Absence of `docs/workstreams/ACTIVE.md` means
 * "check the overrides", not "this project does not use Build OS".
 */

import { DEFAULT_BUILD_OS_PATHS, type BuildOsPaths } from "../../domain/state.ts";

export interface DetectionInput {
  /** Every path in the repository, or at least every markdown path. */
  paths: string[];
  /** Contents of `CLAUDE.md` or the project's agent-instructions file, when present. */
  agentInstructions?: string;
  /** Owner-configured overrides. Always win. */
  overrides?: Partial<BuildOsPaths>;
}

export interface DetectionResult {
  detected: boolean;
  version?: string;
  paths: BuildOsPaths;
  /** How detection concluded, so a repository that "should" be detected can be debugged. */
  evidence: string[];
}

const VERSION_PATTERN = /Build OS\s+v(\d+\.\d+(?:\.\d+)?)/i;
const ADOPTED_VERSION_PATTERN = /Adopted version\s*:\s*v?(\d+\.\d+(?:\.\d+)?)/i;

export function detectBuildOs(input: DetectionInput): DetectionResult {
  const evidence: string[] = [];
  const pathSet = new Set(input.paths);

  const instructions = input.agentInstructions ?? "";
  const version =
    ADOPTED_VERSION_PATTERN.exec(instructions)?.[1] ?? VERSION_PATTERN.exec(instructions)?.[1];

  if (version) evidence.push(`agent instructions declare Build OS v${version}`);
  else if (/build\s*os/i.test(instructions)) evidence.push("agent instructions mention Build OS");

  const resolve = (override: string | undefined, fallback: string, label: string): string => {
    if (override) {
      evidence.push(`${label} overridden to ${override}`);
      return override;
    }
    if (pathSet.has(fallback)) evidence.push(`found ${fallback}`);
    return fallback;
  };

  const paths: BuildOsPaths = {
    projectModel: resolve(
      input.overrides?.projectModel,
      DEFAULT_BUILD_OS_PATHS.projectModel,
      "project model",
    ),
    decisions: resolve(input.overrides?.decisions, DEFAULT_BUILD_OS_PATHS.decisions, "decisions"),
    activeWork: resolve(
      input.overrides?.activeWork,
      DEFAULT_BUILD_OS_PATHS.activeWork,
      "active work",
    ),
    workstreamDir: resolve(
      input.overrides?.workstreamDir,
      DEFAULT_BUILD_OS_PATHS.workstreamDir,
      "workstream directory",
    ),
  };

  const hasOverrides = Object.keys(input.overrides ?? {}).length > 0;
  const hasConventional =
    pathSet.has(paths.activeWork) || pathSet.has(paths.decisions) || pathSet.has(paths.projectModel);
  const hasWorkstreamFiles = input.paths.some((p) =>
    new RegExp(`^${paths.workstreamDir}/WS-\\d{3,}.*\\.md$`).test(p),
  );

  if (hasWorkstreamFiles) evidence.push("found workstream files");

  const detected = Boolean(version) || hasConventional || hasWorkstreamFiles || hasOverrides;
  if (!detected) evidence.push("no Build OS artifacts or overrides found");

  return { detected, version, paths, evidence };
}

/** Files under the workstream directory that the parse contract recognises. */
export function workstreamFilePaths(paths: BuildOsPaths, allPaths: string[]): string[] {
  const pattern = new RegExp(`^${paths.workstreamDir}/WS-\\d{3,}[^/]*\\.md$`);
  return allPaths.filter((p) => pattern.test(p)).sort();
}
