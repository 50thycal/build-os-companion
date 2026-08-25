/**
 * Review verdicts carried by a pull request comment.
 *
 * GitHub will not let an account submit an `APPROVE` or `REQUEST_CHANGES` review on a pull
 * request it authored. In a repository worked by one account — which is every project this
 * Companion was built for — that makes the review artifact the merge gate depends on
 * unobtainable: the reviewer can write the finding, but GitHub records it as a comment, and the
 * gate reads nothing. `REVIEW_PROTOCOL.md` already names a PR comment as evidence equivalent to
 * a review; this is the reader for it.
 *
 * What it does *not* do is infer. A comment is a verdict only when it says so in a fixed form
 * that no ordinary sentence produces:
 *
 * ```markdown
 * Build OS review verdict: Approved
 * Reviewed head: 42ea13c260a8e8952f8dc044e4ac20a6dcfc60e5
 * ```
 *
 * Both lines are required, the head must be a full 40-character SHA, and the marker is a phrase
 * nobody writes by accident. Quoted and fenced text is removed first, so a comment discussing a
 * verdict — replying to one, or quoting the block to disagree with it — never becomes one.
 *
 * The head is named explicitly for the same reason a review's `commit_id` is trusted: it ties
 * the verdict to one commit that already existed when the verdict was given, so a later push
 * cannot inherit it.
 *
 * **This does not establish independence, and does not pretend to.** In a single-account
 * repository the author of a PR can post an approving verdict on it. What the format buys is
 * that doing so is explicit, deliberate, and permanently on the public record — not that the
 * tool can tell a reviewer from an author. The Companion reports what the record says; judging
 * whether the reviewer was independent stays with whoever reads it.
 */

import { stripCodeFences, stripHtmlComments } from "../buildos/markdown.ts";
import { normalizeVerdict } from "../buildos/parse.ts";
import type { ReviewVerdict } from "../../domain/state.ts";
import type { GitHubCommentObservation } from "./types.ts";

const FULL_SHA = /^[0-9a-f]{40}$/i;

const MARKER = /^\s*build os review verdict\s*:\s*(.+?)\s*$/i;
const HEAD = /^\s*reviewed head\s*:\s*(.+?)\s*$/i;

/**
 * Markdown puts emphasis on either side of the colon — `**Field:** value` and `**Field**: value`
 * are both idiomatic, and a reviewer should not have to know which one the parser prefers.
 * Removing the emphasis characters first makes the patterns above about the words alone.
 */
function deemphasize(line: string): string {
  return line.replace(/[*`]/g, "");
}

export interface CommentVerdict {
  verdict: ReviewVerdict;
  /** Lowercased full SHA the verdict was given against. */
  reviewedHead: string;
}

/**
 * A comment restating someone else's words is not a new position.
 *
 * Blockquotes are how GitHub's own "quote reply" works, so without this a reviewer quoting an
 * approval in order to argue with it would be read as issuing one.
 */
function withoutQuotes(body: string): string {
  return body
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");
}

/**
 * The verdict a single comment carries, if it carries one.
 *
 * Returns `undefined` for the overwhelmingly common case of an ordinary comment, for a marker
 * naming a verdict outside the protocol's five, and for a marker whose head is missing or
 * abbreviated — an abbreviated SHA cannot prove which commit was reviewed, so it is refused here
 * exactly as it is in a workstream file.
 */
export function parseCommentVerdict(body: string): CommentVerdict | undefined {
  const lines = withoutQuotes(stripCodeFences(stripHtmlComments(body))).split("\n");

  const markerIndex = lines.findIndex((line) => MARKER.test(deemphasize(line)));
  if (markerIndex === -1) return undefined;

  const verdict = normalizeVerdict(MARKER.exec(deemphasize(lines[markerIndex]!))![1]!);
  if (!verdict) return undefined;

  // The head must follow its own marker, so two verdict blocks in one comment cannot cross-wire.
  for (const raw of lines.slice(markerIndex + 1)) {
    const line = deemphasize(raw);
    if (MARKER.test(line)) break;
    const match = HEAD.exec(line);
    if (!match) continue;
    const head = match[1]!.trim();
    return FULL_SHA.test(head) ? { verdict, reviewedHead: head.toLowerCase() } : undefined;
  }

  return undefined;
}

export interface CommentPosition extends CommentVerdict {
  author: string;
  at: string;
}

/**
 * Every comment-borne verdict on a pull request, oldest first.
 *
 * Currency is decided downstream against reviews from the same author, because a reviewer who
 * approves in a review and later objects in a comment has one current position, not two.
 */
export function commentVerdicts(comments: GitHubCommentObservation[] | undefined): CommentPosition[] {
  const positions: CommentPosition[] = [];
  for (const comment of comments ?? []) {
    const verdict = parseCommentVerdict(comment.body);
    if (verdict) positions.push({ ...verdict, author: comment.author, at: comment.createdAt });
  }
  return positions.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}
