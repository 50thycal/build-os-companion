/**
 * Detect whether a followed repository uses Build OS, and where its artifacts live.
 *
 * The parse contract forbids requiring the conventional paths: Build OS explicitly permits
 * repository-specific documentation conventions. Absence of `docs/workstreams/ACTIVE.md` means
 * "check the overrides", not "this project does not use Build OS".
 */

import {
  DEFAULT_BUILD_OS_PATHS,
  normalizeOperatingMode,
  type BuildOsPaths,
  type OperatingMode,
} from "../../domain/state.ts";
import { stripCodeFences, stripHtmlComments } from "./markdown.ts";

export interface DetectionInput {
  /** Every path in the repository, or at least every markdown path. */
  paths: string[];
  /** Contents of `CLAUDE.md` or the project's agent-instructions file, when present. */
  agentInstructions?: string;
  /**
   * Contents of `VERSION.md`, read only for a repository that has no agent-instructions file.
   *
   * The framework block normally lives in `CLAUDE.md`. Canonical Build OS has no such file — it
   * is a protocol repository, not a codebase an agent works in — and says so where it keeps the
   * block instead: *"recorded here because Build OS has no separate agent-instructions file to
   * carry a framework block."* Reading it there is reading the framework block where it is, not
   * guessing. `detect` already probes for the artifacts a repository actually has, for the same
   * reason and with the same precedent.
   *
   * `README.md` is deliberately **not** a fallback. It carries a worked example framework block
   * declaring `reviewed`, so a repository that is genuinely `solo` would be read as the opposite
   * — the one wrong answer worse than no answer.
   */
  versionFile?: string;
  /** Owner-configured overrides. Always win. */
  overrides?: Partial<BuildOsPaths>;
}

export interface DetectionResult {
  detected: boolean;
  version?: string;
  /** When the project adopted `version`, if its instructions record the date. */
  adoptedAt?: string;
  /**
   * The project's declared operating mode (Build OS v0.8), when it declares one.
   *
   * Absent means the project has not said, which the parse contract reads as `reviewed`. Kept
   * distinct from an explicit `reviewed` here so a caller can tell a declaration from a default.
   */
  operatingMode?: OperatingMode;
  paths: BuildOsPaths;
  /** How detection concluded, so a repository that "should" be detected can be debugged. */
  evidence: string[];
}

const VERSION_PATTERN = /Build OS\s+v(\d+\.\d+(?:\.\d+)?)/i;
const ADOPTED_VERSION_PATTERN = /Adopted version\s*:\s*v?(\d+\.\d+(?:\.\d+)?)/i;
/**
 * `Last compatibility check: v0.5 on 2026-08-24` — the line `FRAMEWORK_SYNC.md` already asks
 * every adopting project to keep. Its date is the project's **adoption boundary**: work that
 * predates it was done under the previous version and is never retroactively judged by the new
 * one.
 */
const ADOPTED_AT_PATTERN =
  /Last compatibility check\s*:\s*v?(\d+\.\d+(?:\.\d+)?)\s+on\s+(\d{4}-\d{2}-\d{2})/i;

/**
 * `- Operating mode: solo` — the framework-block line shape the parse contract specifies.
 *
 * The table form `| Operating mode | solo |` is accepted too, because that is how the canonical
 * repository actually records its own mode. Both are the same declaration written into the two
 * shapes a framework block takes; refusing the second would mean reading canonical Build OS as
 * `reviewed` when it has declared `solo` in the file it points at.
 */
const OPERATING_MODE_PATTERN = /Operating mode\s*[:|]\s*\*{0,2}`?([A-Za-z]+)`?/i;

/**
 * The declared operating mode, or undefined when the text declares none.
 *
 * Fenced and commented text is stripped first, for the reason every other reader here does it:
 * a document *explaining* the modes — and both canonical and this repository's own instructions
 * do — must never be read as *declaring* one.
 */
function declaredOperatingMode(text: string | undefined): OperatingMode | undefined {
  if (!text) return undefined;
  const match = OPERATING_MODE_PATTERN.exec(stripHtmlComments(stripCodeFences(text)));
  return normalizeOperatingMode(match?.[1]);
}

export function detectBuildOs(input: DetectionInput): DetectionResult {
  const evidence: string[] = [];
  const pathSet = new Set(input.paths);

  const instructions = input.agentInstructions ?? "";
  const version =
    ADOPTED_VERSION_PATTERN.exec(instructions)?.[1] ?? VERSION_PATTERN.exec(instructions)?.[1];

  const checked = ADOPTED_AT_PATTERN.exec(instructions);
  // Only trust the date when it belongs to the version actually adopted; a stale check line
  // describing an older version says nothing about when the current one arrived.
  const adoptedAt = checked && version && checked[1] === version ? checked[2] : undefined;

  /**
   * The instructions file first, then `VERSION.md` only when there is no instructions file at
   * all. A project that has a framework block and does not declare a mode has said `reviewed` by
   * omission, and must not have a different answer read out from somewhere else.
   */
  const operatingMode =
    declaredOperatingMode(input.agentInstructions) ??
    (input.agentInstructions === undefined
      ? declaredOperatingMode(input.versionFile)
      : undefined);

  if (version) evidence.push(`agent instructions declare Build OS v${version}`);
  if (operatingMode) evidence.push(`declares operating mode ${operatingMode}`);
  if (adoptedAt) evidence.push(`adopted v${version} on ${adoptedAt}`);
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

  return { detected, version, adoptedAt, operatingMode, paths, evidence };
}

/** Files under the workstream directory that the parse contract recognises. */
export function workstreamFilePaths(paths: BuildOsPaths, allPaths: string[]): string[] {
  const pattern = new RegExp(`^${paths.workstreamDir}/WS-\\d{3,}[^/]*\\.md$`);
  return allPaths.filter((p) => pattern.test(p)).sort();
}
