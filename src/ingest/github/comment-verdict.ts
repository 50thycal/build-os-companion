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
 * `Owner-accepted` names its commit here instead (v0.8), and a consumer keys on the field name
 * to tell an acceptance from an approval. The substitution *is* the signal — nothing was
 * reviewed — so the two are read into separate fields and never merged.
 */
const ACCEPTED_HEAD = /^\s*accepted head\s*:\s*(.+?)\s*$/i;
const ACTOR = /^\s*review actor\s*:\s*(.+?)\s*$/i;
/** The implementation actor as the reviewer saw it, captured inside the verdict itself. */
const REVIEWED_IMPLEMENTATION_ACTOR = /^\s*implementation actor reviewed\s*:\s*(.+?)\s*$/i;
/** Declared by the implementing agent in the PR body, so self-review can be recognised. */
const IMPLEMENTATION_ACTOR = /^\s*implementation actor\s*:\s*(.+?)\s*$/im;

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
  /**
   * Lowercased full SHA the verdict was given against.
   *
   * For an `Owner-accepted` verdict this is absent and `acceptedHead` carries the commit: the
   * field the verdict used is itself part of what the verdict says.
   */
  reviewedHead?: string;
  /** Lowercased full SHA an `Owner-accepted` verdict named. Never folded into `reviewedHead`. */
  acceptedHead?: string;
  /**
   * Prose the comment carried beneath the fields.
   *
   * Kept because of what it carries in practice: a **relayed** acceptance — one an agent
   * transcribed from a decision the owner gave elsewhere — is parsed identically to one the
   * owner posted, and says so only here. The parse contract is explicit that a consumer must not
   * normalise this away when showing the verdict to a person, because the difference between an
   * owner-posted acceptance and an agent's report of one is exactly what this prose carries.
   */
  note?: string;
  /**
   * Who issued the verdict, as distinct from the GitHub account that carried it.
   *
   * The whole premise of this form is a repository where those differ: an owner, an
   * implementation agent and an independent reviewer can all post as the same login, and a
   * record keyed on the login cannot answer who actually spoke. Absent when the comment did not
   * declare one — in which case the verdict is evidence, never gate-clearing.
   */
  actor?: string;
  /**
   * The implementation actor **as the reviewer recorded it**, inside the verdict.
   *
   * The PR body is editable and the head does not move when it changes, so comparing a verdict
   * against the body's *current* declaration would let a self-review be turned into an
   * independent one afterwards: post a non-clearing verdict, then edit the body to name a
   * different implementer, and the old comment silently becomes gate-clearing. Capturing the
   * pair inside the artifact makes the comparison as immutable as the verdict it belongs to.
   */
  reviewedImplementationActor?: string;
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

  // Fields belong to their own marker, so two verdict blocks in one comment cannot cross-wire.
  let head: string | undefined;
  let acceptedHead: string | undefined;
  let actor: string | undefined;
  let reviewedImplementationActor: string | undefined;
  const prose: string[] = [];

  for (const raw of lines.slice(markerIndex + 1)) {
    const line = deemphasize(raw);
    if (MARKER.test(line)) break;

    const headMatch = HEAD.exec(line);
    if (headMatch && head === undefined) {
      const candidate = headMatch[1]!.trim();
      // An abbreviated SHA is refused rather than ignored: the block claims a head and cannot
      // prove which one, which is worse than claiming none.
      if (!FULL_SHA.test(candidate)) return undefined;
      head = candidate.toLowerCase();
      continue;
    }

    const acceptedMatch = ACCEPTED_HEAD.exec(line);
    if (acceptedMatch && acceptedHead === undefined) {
      const candidate = acceptedMatch[1]!.trim();
      if (!FULL_SHA.test(candidate)) return undefined;
      acceptedHead = candidate.toLowerCase();
      continue;
    }

    // Checked before `ACTOR`: "Implementation actor reviewed" does not contain "Review actor",
    // but keeping the more specific field first makes that independent of the patterns' shapes.
    const reviewedMatch = REVIEWED_IMPLEMENTATION_ACTOR.exec(line);
    if (reviewedMatch && reviewedImplementationActor === undefined) {
      const candidate = reviewedMatch[1]!.trim();
      if (candidate !== "") reviewedImplementationActor = candidate;
      continue;
    }

    const actorMatch = ACTOR.exec(line);
    if (actorMatch && actor === undefined) {
      const candidate = actorMatch[1]!.trim();
      if (candidate !== "") actor = candidate;
      continue;
    }

    // Anything that is not one of the fields is the comment's own words. A relayed acceptance
    // lives here and nowhere else, so it is kept rather than discarded with the rest.
    if (raw.trim() !== "") prose.push(raw.trim());
  }

  /**
   * A verdict names a commit, in whichever field belongs to it. An `Owner-accepted` that names
   * a `Reviewed head` has said something the protocol does not allow it to say — nothing was
   * reviewed — so the mismatched pairing is refused rather than quietly re-filed.
   */
  const namedHead = verdict === "OWNER_ACCEPTED" ? acceptedHead : head;
  if (namedHead === undefined) return undefined;

  return {
    verdict,
    reviewedHead: head,
    acceptedHead,
    actor,
    reviewedImplementationActor,
    note: prose.length > 0 ? prose.join(" ") : undefined,
  };
}

/**
 * The actor a pull request's own handoff says implemented it.
 *
 * Read so that a verdict issued by that same actor is recognised as self-review. Nothing here
 * verifies the claim — an implementing agent that declines to name itself simply leaves the
 * comparison unavailable, which is why an undeclared implementation actor makes every comment
 * verdict non-gate-clearing rather than trivially independent.
 */
export function implementationActor(body: string | undefined): string | undefined {
  if (!body) return undefined;
  const match = IMPLEMENTATION_ACTOR.exec(
    withoutQuotes(stripCodeFences(stripHtmlComments(body))).replace(/[*`]/g, ""),
  );
  const actor = match?.[1]?.trim();
  return actor === "" ? undefined : actor;
}

export interface CommentPosition extends CommentVerdict {
  author: string;
  at: string;
  /**
   * The comment has been edited since it was posted.
   *
   * A comment is editable in place, so an approval can be written *after* the fact — a
   * `Changes required` rewritten to `Approved`, a head or an actor swapped — while the commit it
   * names stays fixed. An edited comment is therefore never gate-clearing. It still closes the
   * gate when it objects: refusing to open on doubtful evidence and refusing to close on it are
   * not symmetric, and only one of them is safe.
   */
  edited: boolean;
}

/**
 * Every comment-borne verdict on a pull request, oldest first.
 *
 * Currency is decided downstream, keyed on the **actor** rather than the GitHub login. Two
 * reviewers relayed through one account are two reviewers; one reviewer who approves in a review
 * and later objects in a comment is one position, and it is the later one.
 */
export function commentVerdicts(comments: GitHubCommentObservation[] | undefined): CommentPosition[] {
  const positions: CommentPosition[] = [];
  for (const comment of comments ?? []) {
    const verdict = parseCommentVerdict(comment.body);
    if (verdict) {
      positions.push({
        ...verdict,
        author: comment.author,
        at: comment.createdAt,
        // GitHub sets updatedAt == createdAt on a comment that has never been edited.
        edited: comment.updatedAt !== undefined && comment.updatedAt !== comment.createdAt,
      });
    }
  }
  return positions.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}
