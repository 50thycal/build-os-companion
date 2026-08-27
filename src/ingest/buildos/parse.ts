/**
 * Build OS artifact parsers.
 *
 * Governed by build-os `framework/BUILD_OS_PARSE_CONTRACT.md`. The rule that shapes every
 * function here: a field that cannot be read confidently is *absent*, never guessed. An absent
 * phase is a parser admitting ignorance, which the product can show honestly. A guessed phase is
 * a lie with a confident face.
 */

import {
  REVIEW_VERDICTS,
  WORKSTREAM_PHASES,
  WORKSTREAM_STATUSES,
  type DecisionRecord,
  type DecisionStatus,
  type OpenDecision,
  type ReviewVerdict,
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
  stripHtmlComments,
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

/**
 * The Build OS version a workstream declares for itself, from `**Build OS:** v0.5`.
 *
 * Only the header block is read: a mention of a version in the body is prose about a release,
 * not a declaration of the protocol this workstream runs under.
 */
function parseProtocolVersion(markdown: string): string | undefined {
  const raw = headerField(markdown, "Build OS") ?? headerField(markdown, "Protocol");
  if (!raw) return undefined;
  const match = /v?(\d+\.\d+(?:\.\d+)?)/.exec(raw.replace(/[*`]/g, ""));
  return match ? `v${match[1]}` : undefined;
}

// ---------------------------------------------------------------------------
// Review State fields (v0.5)
// ---------------------------------------------------------------------------

const FULL_SHA = /^[0-9a-f]{40}$/i;

export interface ParsedReviewRecord {
  /** Absent when the record names no PR. Reconciliation binds it to one. */
  prNumber?: number;
  verdict?: ReviewVerdict;
  reviewedHead?: string;
  finalized: boolean;
}

export interface ParsedReviewState {
  /**
   * One record per reviewed PR. The field form yields at most one; the table form yields one
   * per row, which is what a workstream spanning several PRs needs.
   */
  records: ParsedReviewRecord[];
  /** Set when a field was present but unreadable. The field itself stays absent. */
  verdictMalformed: boolean;
  reviewedHeadMalformed: boolean;
}

export function normalizeVerdict(text: string): ReviewVerdict | undefined {
  const normalized = text
    .trim()
    .toUpperCase()
    .replace(/\.$/, "")
    .replace(/[\s-]+/g, "_")
    .replace(/_WITH_FOLLOWUPS?$/, "_WITH_FOLLOW_UPS");
  return (REVIEW_VERDICTS as readonly string[]).includes(normalized)
    ? (normalized as ReviewVerdict)
    : undefined;
}

/** `pushed`, `yes`, `done` — anything that is not an absence marker means the commit is on the PR. */
function parseFinalized(text: string | undefined): boolean {
  if (text === undefined) return false;
  const cleaned = text.replace(/[*`]/g, "").trim();
  if (cleaned === "" || isNothing(cleaned)) return false;
  return !/^(no|not required|n\/a|pending|not pushed)\b/i.test(cleaned);
}

interface HeadResult {
  head?: string;
  malformed: boolean;
}

/**
 * An abbreviated SHA is rejected rather than accepted: a 7-character prefix cannot prove which
 * commit was reviewed, and proof is the entire point of the field.
 */
function parseHead(raw: string | undefined): HeadResult {
  if (raw === undefined) return { malformed: false };
  const head = raw.replace(/[*`]/g, "").trim();
  if (head === "" || isNothing(head)) return { malformed: false };
  if (FULL_SHA.test(head)) return { head: head.toLowerCase(), malformed: false };
  return { malformed: true };
}

/**
 * The per-PR table form:
 *
 * ```markdown
 * | PR | Verdict | Reviewed head | Finalization |
 * |---|---|---|---|
 * | #84 | Approved | <40-char SHA> | pushed |
 * ```
 */
function parseReviewTable(stripped: string): ParsedReviewState | undefined {
  const table = parseTables(stripped).find(
    (t) => columnIndex(t.headers, "pr") !== -1 && columnIndex(t.headers, "verdict") !== -1,
  );
  if (!table) return undefined;

  const prIdx = columnIndex(table.headers, "pr");
  const verdictIdx = columnIndex(table.headers, "verdict");
  const headIdx = columnIndex(table.headers, "reviewed head", "head");
  const finalIdx = columnIndex(table.headers, "finalization", "finalized");

  const result: ParsedReviewState = {
    records: [],
    verdictMalformed: false,
    reviewedHeadMalformed: false,
  };

  for (const row of table.rows) {
    const prCell = cell(row, prIdx);
    const record: ParsedReviewRecord = {
      prNumber: prCell ? extractPrNumbers(prCell)[0] : undefined,
      finalized: parseFinalized(cell(row, finalIdx)),
    };

    const verdictCell = cell(row, verdictIdx);
    if (verdictCell !== undefined) {
      const verdict = normalizeVerdict(verdictCell.replace(/\*+/g, ""));
      if (verdict) record.verdict = verdict;
      else result.verdictMalformed = true;
    }

    const head = parseHead(cell(row, headIdx));
    if (head.head) record.reviewedHead = head.head;
    if (head.malformed) result.reviewedHeadMalformed = true;

    // A row claiming nothing about nothing is table padding, not a review record.
    if (record.prNumber === undefined && !record.verdict && !record.reviewedHead) continue;
    result.records.push(record);
  }

  return result.records.length > 0 ? result : undefined;
}

/**
 * Read the v0.5 review fields from a Review State body.
 *
 * Two accepted forms: the single-record field form for the common one-PR case, and a per-PR
 * table for a workstream spanning several. A body with neither is a workstream written before
 * v0.5 — absent metadata, not an error.
 */
export function parseReviewState(body: string | undefined): ParsedReviewState {
  const empty: ParsedReviewState = { records: [], verdictMalformed: false, reviewedHeadMalformed: false };
  if (body === undefined) return empty;

  const stripped = stripHtmlComments(stripCodeFences(body));

  const table = parseReviewTable(stripped);
  if (table) return table;

  const result: ParsedReviewState = { records: [], verdictMalformed: false, reviewedHeadMalformed: false };
  const record: ParsedReviewRecord = { finalized: false };
  let present = false;

  const verdictRaw = /\*{0,2}Verdict\*{0,2}\s*:\s*\*{0,2}\s*([^\n|]+)/i.exec(stripped)?.[1];
  if (verdictRaw !== undefined) {
    present = true;
    const verdict = normalizeVerdict(verdictRaw.replace(/\*+/g, ""));
    if (verdict) record.verdict = verdict;
    else result.verdictMalformed = true;
  }

  const headRaw = /\*{0,2}Reviewed\s+head\*{0,2}\s*:\s*\*{0,2}\s*([^\n|]+)/i.exec(stripped)?.[1];
  if (headRaw !== undefined) {
    present = true;
    const head = parseHead(headRaw);
    if (head.head) record.reviewedHead = head.head;
    if (head.malformed) result.reviewedHeadMalformed = true;
  }

  const prRaw = /\*{0,2}Reviewed\s+PR\*{0,2}\s*:\s*\*{0,2}\s*([^\n|]+)/i.exec(stripped)?.[1];
  if (prRaw !== undefined) {
    const numbers = extractPrNumbers(prRaw);
    if (numbers.length > 0) {
      present = true;
      record.prNumber = numbers[0];
    }
  }

  const finalRaw = /\*{0,2}Finalization\*{0,2}\s*:\s*\*{0,2}\s*([^\n|]+)/i.exec(stripped)?.[1];
  if (finalRaw !== undefined && parseFinalized(finalRaw)) {
    present = true;
    record.finalized = true;
  }

  if (present) result.records.push(record);
  return result;
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
  /** From a `**Build OS:** v0.5` header field. Absent means "inherit the project's pin". */
  protocolVersion?: string;
  goal?: string;
  nextStep?: string;
  openDecisions: OpenDecision[];
  decisionsMade: string[];
  relatedPrNumbers: number[];
  relatedDecisionIds: string[];
  buildCardReady: boolean;
  implementationState?: string;
  reviewState?: string;
  review: ParsedReviewState;
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
    protocolVersion: parseProtocolVersion(markdown),
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
    review: parseReviewState(findSection(sections, "Review State")?.body),
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
