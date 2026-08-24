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

  /**
   * Where each artifact is allowed to live, most conventional first.
   *
   * Build OS permits repository-specific documentation conventions, and the two repositories
   * the Companion follows genuinely differ: party-games keeps `docs/DECISIONS.md`, while
   * build-os keeps `DECISIONS.md` at the repository root and has no project model at all.
   * Resolving to the convention regardless of what is there made build-os report zero
   * decisions — not an error, just a quietly empty section, which is the worst way for this to
   * fail. So the candidates are probed against the paths the repository actually has.
   */
  const CANDIDATES: Record<keyof BuildOsPaths, string[]> = {
    projectModel: [DEFAULT_BUILD_OS_PATHS.projectModel, "PROJECT_MODEL.md", "docs/project-model.md"],
    decisions: [DEFAULT_BUILD_OS_PATHS.decisions, "DECISIONS.md", "docs/decisions.md"],
    activeWork: [DEFAULT_BUILD_OS_PATHS.activeWork, "docs/ACTIVE.md", "ACTIVE.md"],
    workstreamDir: [DEFAULT_BUILD_OS_PATHS.workstreamDir, "workstreams", "docs/workstream"],
  };

  const hasDirectory = (dir: string): boolean =>
    input.paths.some((p) => p.startsWith(`${dir}/`));

  const resolve = (
    key: keyof BuildOsPaths,
    override: string | undefined,
    label: string,
    isDirectory = false,
  ): string => {
    if (override) {
      evidence.push(`${label} overridden to ${override}`);
      return override;
    }
    const candidates = CANDIDATES[key];
    const found = candidates.find((c) => (isDirectory ? hasDirectory(c) : pathSet.has(c)));
    if (found) {
      evidence.push(found === candidates[0] ? `found ${found}` : `found ${found} (non-default location)`);
      return found;
    }
    // Nothing matched: fall back to the convention so the path is still reportable.
    return candidates[0]!;
  };

  const paths: BuildOsPaths = {
    projectModel: resolve("projectModel", input.overrides?.projectModel, "project model"),
    decisions: resolve("decisions", input.overrides?.decisions, "decisions"),
    activeWork: resolve("activeWork", input.overrides?.activeWork, "active work"),
    workstreamDir: resolve("workstreamDir", input.overrides?.workstreamDir, "workstream directory", true),
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
