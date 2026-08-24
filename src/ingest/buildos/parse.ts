/**
 * Build OS artifact parsers.
 *
 * Governed by build-os `framework/BUILD_OS_PARSE_CONTRACT.md`. The rule that shapes every
 * function here: a field that cannot be read confidently is *absent*, never guessed. An absent
 * phase is a parser admitting ignorance, which the product can show honestly. A guessed phase is
 * a lie with a confident face.
 */

import {
  WORKSTREAM_PHASES,
  WORKSTREAM_STATUSES,
  type DecisionRecord,
  type DecisionStatus,
  type OpenDecision,
  type WorkstreamPhase,
  type WorkstreamStatus,
} from "../../domain/state.ts";
import {
  cell,
  columnIndex,
  extractDecisionIds,
  extractPrNumbers,
  findSection,
  headerField,
  isNothing,
  listItems,
  parseSections,
  parseTables,
  stripCodeFences,
} from "./markdown.ts";

export const WORKSTREAM_ID_PATTERN = /\bWS-(\d{3,})\b/;

/**
 * Collapse a wrapped prose block to one line.
 *
 * Paragraph breaks become a single space rather than being preserved, because every consumer of
 * these fields shows them inline. A blank line in the middle of `Next Step` is not information;
 * it is the artifact's line width leaking into the product.
 */
function collapseProse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function parseWorkstreamId(text: string): string | undefined {
  const match = WORKSTREAM_ID_PATTERN.exec(text);
  return match ? `WS-${match[1]}` : undefined;
}

function parsePhase(text: string | undefined): WorkstreamPhase | undefined {
  if (!text) return undefined;
  const normalized = text.trim().toUpperCase().replace(/[\s-]+/g, "_");
  return (WORKSTREAM_PHASES as readonly string[]).includes(normalized)
    ? (normalized as WorkstreamPhase)
    : undefined;
}

function parseStatus(text: string | undefined): WorkstreamStatus | undefined {
  if (!text) return undefined;
  const normalized = text.trim().toUpperCase();
  return (WORKSTREAM_STATUSES as readonly string[]).includes(normalized)
    ? (normalized as WorkstreamStatus)
    : undefined;
}

// ---------------------------------------------------------------------------
// ACTIVE.md
// ---------------------------------------------------------------------------

export interface ActiveBoardRow {
  workstreamId: string;
  title?: string;
  phase?: WorkstreamPhase;
  status?: WorkstreamStatus;
  nextStep?: string;
  relatedPrNumbers: number[];
}

export interface ActiveBoard {
  rows: ActiveBoardRow[];
  /** Rows the parser refused: an unreadable ID means the row is skipped, never repaired. */
  skippedRows: number;
}

export function parseActiveBoard(markdown: string): ActiveBoard {
  const tables = parseTables(markdown).filter(
    (t) => !t.section.includes("recently completed") && !t.section.includes("completed work"),
  );

  const board = tables.find(
    (t) => columnIndex(t.headers, "id") !== -1 && columnIndex(t.headers, "workstream") !== -1,
  );
  if (!board) return { rows: [], skippedRows: 0 };

  const idIdx = columnIndex(board.headers, "id");
  const titleIdx = columnIndex(board.headers, "workstream");
  const phaseIdx = columnIndex(board.headers, "phase");
  const statusIdx = columnIndex(board.headers, "status");
  const nextIdx = columnIndex(board.headers, "next step");
  const prIdx = columnIndex(board.headers, "related pr", "pr");

  const rows: ActiveBoardRow[] = [];
  let skippedRows = 0;

  for (const row of board.rows) {
    const rawId = cell(row, idIdx);
    const workstreamId = rawId ? parseWorkstreamId(rawId) : undefined;
    if (!workstreamId) {
      // A template placeholder row is not a broken row; only count rows with real content.
      if (row.some((c) => c.trim() !== "" && c.trim() !== "—" && c.trim() !== "-")) skippedRows += 1;
      continue;
    }
    const prCell = cell(row, prIdx);
    rows.push({
      workstreamId,
      title: cell(row, titleIdx),
      phase: parsePhase(cell(row, phaseIdx)),
      status: parseStatus(cell(row, statusIdx)),
      nextStep: cell(row, nextIdx),
      relatedPrNumbers: prCell ? extractPrNumbers(prCell) : [],
    });
  }

  return { rows, skippedRows };
}

// ---------------------------------------------------------------------------
// Workstream file
// ---------------------------------------------------------------------------

export interface ParsedWorkstreamFile {
  /** From the `# WS-### — title` heading. */
  headingWorkstreamId?: string;
  title?: string;
  phase?: WorkstreamPhase;
  status?: WorkstreamStatus;
  createdAt?: string;
  updatedAt?: string;
  goal?: string;
  nextStep?: string;
  openDecisions: OpenDecision[];
  decisionsMade: string[];
  relatedPrNumbers: number[];
  relatedDecisionIds: string[];
  buildCardReady: boolean;
  implementationState?: string;
  reviewState?: string;
}

/**
 * The shortest prefix of `text` that is at least `minChars` long and ends on a sentence
 * boundary.
 *
 * Build OS writes a decision as a bold label followed by the decision and then its reasoning:
 * `**D1. Shelving.** A company may leave a contract off the schedule entirely and eat its
 * incomplete penalty…`. Stopping at the first full stop yields "Shelving." — a label, not a
 * decision — so short leading sentences are absorbed until there is something to read.
 */
function leadingSentences(text: string, minChars: number): string {
  const boundary = /([.?!])(\s+|$)/g;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(text)) !== null) {
    const end = match.index + 1;
    if (end >= minChars) return text.slice(0, end).trim();
  }
  return text.trim();
}

/**
 * `**D1.** Question?` or `- D3 — question`. Falls back to a positional key.
 *
 * A real entry is a wrapped paragraph carrying the decision, its rationale, the options, and a
 * recommendation. All of it is kept: `question` is the part that fits on an attention line and
 * `detail` is the whole entry, so nothing the artifact said is lost by summarizing it.
 */
function parseOpenDecisions(body: string): OpenDecision[] {
  if (isNothing(body)) return [];
  const items = listItems(body);
  const source = items.length > 0 ? items : body.split("\n").filter((l) => l.trim() !== "");

  const decisions: OpenDecision[] = [];
  for (const [index, item] of source.entries()) {
    const cleaned = item.replace(/\*\*/g, "").trim();
    if (cleaned === "" || isNothing(cleaned)) continue;
    const keyed = /^(D\d+)[.)]?\s*[—–-]?\s*(.*)$/i.exec(cleaned);
    const key = keyed ? keyed[1]!.toUpperCase() : `D${index + 1}`;
    const full = (keyed ? keyed[2]! : cleaned).trim();
    const question = leadingSentences(full, 40);
    decisions.push(question === full ? { key, question } : { key, question, detail: full });
  }
  return decisions;
}

export function parseWorkstreamFile(markdown: string): ParsedWorkstreamFile {
  const stripped = stripCodeFences(markdown);
  const headingMatch = /^#\s+(WS-\d{3,})\s*[—–-]\s*(.+)$/m.exec(stripped);
  const sections = parseSections(markdown, 2);

  // Section prose is hard-wrapped in the artifact. These fields are rendered inline — on a feed
  // card, in an attention sentence, in a briefing line — so the wrapping is a detail of how the
  // file is stored, not of what it says, and it is collapsed on the way in. A card that renders
  // a raw newline is showing the owner the file's line width, which is never what they asked.
  const sectionText = (...names: string[]): string | undefined => {
    const body = findSection(sections, ...names)?.body;
    if (body === undefined || isNothing(body)) return undefined;
    const collapsed = collapseProse(body);
    return collapsed === "" ? undefined : collapsed;
  };

  const relatedPrsBody = findSection(sections, "Related PRs")?.body ?? "";
  const implementationState = sectionText("Implementation State");
  const buildCard = findSection(sections, "Build Card")?.body ?? "";

  return {
    headingWorkstreamId: headingMatch?.[1],
    title: headingMatch?.[2]?.trim(),
    phase: parsePhase(headerField(markdown, "Phase")),
    status: parseStatus(headerField(markdown, "Status")),
    createdAt: headerField(markdown, "Created"),
    updatedAt: headerField(markdown, "Updated"),
    goal: sectionText("Goal"),
    nextStep: sectionText("Next Step"),
    openDecisions: parseOpenDecisions(findSection(sections, "Open Decisions")?.body ?? ""),
    decisionsMade: listItems(findSection(sections, "Decisions Made")?.body ?? ""),
    // A PR referenced in Implementation State counts as related; Build OS writes it both ways.
    relatedPrNumbers: [
      ...new Set([
        ...extractPrNumbers(relatedPrsBody),
        ...extractPrNumbers(implementationState ?? ""),
      ]),
    ].sort((a, b) => a - b),
    relatedDecisionIds: extractDecisionIds(findSection(sections, "Related Decisions")?.body ?? ""),
    buildCardReady: !isNothing(buildCard),
    implementationState,
    reviewState: sectionText("Review State"),
  };
}

// ---------------------------------------------------------------------------
// DECISIONS.md
// ---------------------------------------------------------------------------

export interface ParsedDecision {
  decisionId: string;
  title: string;
  date?: string;
  status: DecisionStatus;
  supersededBy?: string;
}

function parseDecisionStatus(text: string): { status: DecisionStatus; supersededBy?: string } {
  const normalized = text.trim().toLowerCase();
  const superseded = /superseded by\s+(dec-\d{3,})/i.exec(text);
  if (superseded) {
    return { status: "SUPERSEDED", supersededBy: superseded[1]!.toUpperCase() };
  }
  if (normalized.startsWith("accepted")) return { status: "ACCEPTED" };
  if (normalized.startsWith("proposed")) return { status: "PROPOSED" };
  if (normalized.startsWith("deprecated")) return { status: "DEPRECATED" };
  return { status: "PROPOSED" };
}

export function parseDecisions(markdown: string): ParsedDecision[] {
  const stripped = stripCodeFences(markdown);
  const entries: ParsedDecision[] = [];
  const headingPattern = /^###\s+(DEC-\d{3,})\s*[—–-]\s*(.+)$/gm;

  const matches = [...stripped.matchAll(headingPattern)];
  for (const [index, match] of matches.entries()) {
    const start = match.index! + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1]!.index! : stripped.length;
    const body = stripped.slice(start, end);

    const statusLine = /\*{0,2}Status\*{0,2}\s*:\s*\*{0,2}\s*(.+)/i.exec(body)?.[1] ?? "";
    const dateLine = /\*{0,2}Date\*{0,2}\s*:\s*\*{0,2}\s*(\d{4}-\d{2}-\d{2})/i.exec(body)?.[1];
    const { status, supersededBy } = parseDecisionStatus(statusLine.split("·")[0]!);

    entries.push({
      decisionId: match[1]!,
      title: match[2]!.trim(),
      date: dateLine,
      status,
      supersededBy,
    });
  }

  return entries;
}

export function toDecisionRecords(
  projectId: string,
  sourcePath: string,
  parsed: ParsedDecision[],
  sourceUrl?: string,
): DecisionRecord[] {
  return parsed.map((d) => ({
    projectId,
    decisionId: d.decisionId,
    title: d.title,
    date: d.date,
    status: d.status,
    supersededBy: d.supersededBy,
    sourcePath,
    sourceUrl,
  }));
}
