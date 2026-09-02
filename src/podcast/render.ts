/**
 * Rendering a podcast script as a plain-text transcript.
 *
 * Deterministic, like `briefing/render.ts`: this is the debugging layer WS-006 calls for — if
 * the text is wrong, the audio (whenever that exists) would be wrong too. It renders the script
 * and nothing else; it does not reach back into a fact pack or re-derive anything.
 */

import type { PodcastScript } from "./types.ts";

export interface RenderPodcastOptions {
  /** Include the reference ids after each line. Useful when checking a script's grounding. */
  includeRefs?: boolean;
}

export function renderPodcastScript(script: PodcastScript, options: RenderPodcastOptions = {}): string {
  const lines: string[] = [];
  lines.push(`# ${script.title}`, "");
  lines.push(`${script.kind === "DIGEST" ? "Digest" : "Deep dive"} · generated ${script.generatedAt}`, "");

  for (const segment of script.segments) {
    lines.push(`## ${segment.title}`, "");
    for (const line of segment.lines) {
      lines.push(`${line.speaker}: ${line.text}`);
      if (options.includeRefs && line.refs.length > 0) {
        lines.push(`  refs: ${line.refs.map((r) => `${r.kind}/${r.id}`).join(", ")}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}
