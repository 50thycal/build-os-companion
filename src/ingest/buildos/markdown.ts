/**
 * Small markdown helpers shared by the Build OS parsers.
 *
 * Deliberately not a markdown library. The parse contract pins a narrow surface — tables with
 * known headers, `**Field:** value` lines, `##` sections — and hand-rolling that surface keeps
 * the parsers conservative and their failure modes obvious.
 */

export interface MarkdownTable {
  /** Heading text the table appeared under, lowercased. Empty when before any heading. */
  section: string;
  headers: string[];
  rows: string[][];
}

export interface MarkdownSection {
  /** Heading text without the leading hashes. */
  heading: string;
  level: number;
  body: string;
}

const FENCE = /^\s*```/;

/** Strip fenced code blocks so examples inside documentation are never parsed as content. */
export function stripCodeFences(markdown: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      out.push("");
      continue;
    }
    out.push(inFence ? "" : line);
  }
  return out.join("\n");
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

const DIVIDER = /^\s*\|?[\s:-]*\|[\s|:-]*$/;

export function parseTables(markdown: string): MarkdownTable[] {
  const lines = stripCodeFences(markdown).split("\n");
  const tables: MarkdownTable[] = [];
  let section = "";

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;

    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      section = heading[1]!.trim().toLowerCase();
      continue;
    }

    const next = lines[i + 1];
    if (!line.includes("|") || next === undefined || !DIVIDER.test(next)) continue;

    const headers = splitRow(line);
    const rows: string[][] = [];
    let j = i + 2;
    while (j < lines.length && lines[j]!.includes("|") && lines[j]!.trim() !== "") {
      rows.push(splitRow(lines[j]!));
      j += 1;
    }
    tables.push({ section, headers, rows });
    i = j - 1;
  }

  return tables;
}

/** Match a header by case-insensitive substring, so `Current Next Step` matches `next step`. */
export function columnIndex(headers: string[], ...needles: string[]): number {
  for (const needle of needles) {
    const idx = headers.findIndex((h) => h.toLowerCase().includes(needle.toLowerCase()));
    if (idx !== -1) return idx;
  }
  return -1;
}

export function cell(row: string[], index: number): string | undefined {
  if (index < 0) return undefined;
  const value = row[index];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "—" || trimmed === "-" || trimmed === "–") return undefined;
  return trimmed;
}

/** Split into `##`-and-deeper sections, keyed by heading. */
export function parseSections(markdown: string, level = 2): MarkdownSection[] {
  const lines = markdown.split("\n");
  const sections: MarkdownSection[] = [];
  let current: MarkdownSection | undefined;
  const buffer: string[] = [];
  let inFence = false;

  const flush = () => {
    if (current) {
      sections.push({ ...current, body: buffer.join("\n").trim() });
    }
    buffer.length = 0;
  };

  for (const line of lines) {
    if (FENCE.test(line)) inFence = !inFence;

    const heading = !inFence ? /^(#{1,6})\s+(.*)$/.exec(line) : null;
    if (heading && heading[1]!.length === level) {
      flush();
      current = { heading: heading[2]!.trim(), level, body: "" };
      continue;
    }
    if (current) buffer.push(line);
  }
  flush();
  return sections;
}

export function findSection(
  sections: MarkdownSection[],
  ...names: string[]
): MarkdownSection | undefined {
  for (const name of names) {
    const match = sections.find((s) => s.heading.toLowerCase() === name.toLowerCase());
    if (match) return match;
  }
  return undefined;
}

/**
 * Read a header field from the block above the first `##` section.
 *
 * Build OS writes these several ways — `**Phase:** BUILDING`, `Phase: BUILDING`, and
 * `**Phase:** BUILDING · **Status:** Active` on one line — so the colon may sit inside or
 * outside the bold markers, and two fields may share a line separated by a middle dot.
 *
 * Restricted to the header block on purpose: the word "Status" appears in ordinary prose
 * further down every workstream file, and matching that would produce confident nonsense.
 */
export function headerField(markdown: string, field: string): string | undefined {
  const stripped = stripCodeFences(markdown);
  const firstSection = stripped.search(/^##\s/m);
  const headerBlock = firstSection === -1 ? stripped : stripped.slice(0, firstSection);

  const pattern = new RegExp(`\\*{0,2}${field}\\*{0,2}\\s*:\\s*\\*{0,2}\\s*([^\\n\u00b7|]+)`, "i");
  const match = pattern.exec(headerBlock);
  if (!match) return undefined;

  const value = match[1]!.replace(/\*+/g, "").trim();
  return value === "" ? undefined : value;
}

/** Bullet list items in a section body, with markers and bold wrappers removed. */
export function listItems(body: string): string[] {
  return stripCodeFences(body)
    .split("\n")
    .map((line) => /^\s*[-*+]\s+(.*)$/.exec(line)?.[1]?.trim())
    .filter((item): item is string => item !== undefined && item !== "");
}

export function extractPrNumbers(text: string): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(/#(\d+)\b/g)) {
    found.add(Number(match[1]));
  }
  return [...found].sort((a, b) => a - b);
}

export function extractDecisionIds(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\bDEC-(\d{3,})\b/g)) {
    found.add(`DEC-${match[1]}`);
  }
  return [...found].sort();
}

/**
 * `None`, `None yet`, `Not ready`, `Not started` and dashes all mean "nothing here".
 *
 * Matched on the opening words rather than the whole string, because Build OS writes these as
 * sentences: "Not ready. Blocked on D3." and "None. All resolved before the Build Card was
 * approved." both mean nothing is there.
 */
export function isNothing(text: string | undefined): boolean {
  if (text === undefined) return true;
  const normalized = text.trim().toLowerCase();
  if (normalized === "" || /^[-\u2013\u2014]+$/.test(normalized)) return true;

  return [
    "none",
    "not ready",
    "not started",
    "not yet",
    "nothing",
    "n/a",
  ].some((token) => normalized === token || normalized.startsWith(`${token}.`) || normalized.startsWith(`${token} `));
}
