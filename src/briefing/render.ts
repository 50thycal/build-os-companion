/**
 * Rendering a fact pack as text.
 *
 * Deterministic: same pack, same words, every time. That is a feature and not a placeholder for
 * something cleverer. A briefing the owner acts on without opening GitHub has to be one they can
 * trust completely, and a sentence assembled from facts they can click through to is worth more
 * than a smoother one they have to take on faith.
 *
 * If prose generation is added later, this is the contract it inherits: it renders the supplied
 * pack and nothing else. It may not query the ledger, call GitHub, or assert anything that no
 * `FactRef` accounts for.
 */

import type { FactPack, FactSection } from "./fact-pack.ts";

export interface RenderOptions {
  /** Include the reference ids after each fact. Useful when checking the pack's grounding. */
  includeRefs?: boolean;
  /** Skip sections with no facts rather than printing their empty text. */
  omitEmpty?: boolean;
}

function renderSection(section: FactSection, options: RenderOptions): string[] {
  const lines = [`## ${section.title}`, ""];

  if (section.facts.length === 0) {
    lines.push(section.emptyText, "");
    return lines;
  }

  for (const fact of section.facts) {
    const severity = fact.severity && fact.severity !== "NONE" ? `[${fact.severity}] ` : "";
    lines.push(`- ${severity}${fact.projectName}: ${fact.text}`);
    if (fact.detail) lines.push(`  ${fact.detail}`);
    if (fact.action) lines.push(`  -> ${fact.action}`);
    if (options.includeRefs && fact.refs.length > 0) {
      lines.push(`  refs: ${fact.refs.map((r) => `${r.kind}/${r.id}`).join(", ")}`);
    }
  }
  lines.push("");
  return lines;
}

export function renderFactPack(pack: FactPack, options: RenderOptions = {}): string {
  const lines: string[] = [];

  lines.push(`# Catch-up briefing`, "");
  lines.push(
    pack.isFirstLook
      ? `First look. Everything below is existing state, not news — nothing has been marked read yet.`
      : `Covering ${pack.toSequence - pack.fromSequence} newly recorded event${
          pack.toSequence - pack.fromSequence === 1 ? "" : "s"
        } since you last checked.`,
  );
  lines.push("");

  const stale = pack.projects.filter((p) => p.staleSince);
  if (stale.length > 0) {
    lines.push(
      `Stale: ${stale
        .map((p) => `${p.projectName} (last synced ${p.lastSyncedAt ?? "never"}; ${p.syncError ?? "sync failing"})`)
        .join("; ")}.`,
      "",
    );
  }

  for (const section of pack.sections) {
    if (options.omitEmpty && section.facts.length === 0) continue;
    lines.push(...renderSection(section, options));
  }

  return lines.join("\n").trimEnd() + "\n";
}
