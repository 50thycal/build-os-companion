/**
 * Verdicts carried by a pull request comment.
 *
 * GitHub refuses to let anyone submit a review on a pull request they authored. In a repository
 * worked by one account that makes the review artifact the v0.5 merge gate depends on
 * unobtainable — the reviewer writes the finding, GitHub files it as a comment, and the gate
 * reads nothing. Both merges in this project's own history landed that way.
 *
 * So a comment can carry a verdict, in one fixed form. These tests are mostly about everything
 * that must *not* be read as one.
 */

import { describe, expect, it } from "vitest";

import {
  commentVerdicts,
  implementationActor,
  parseCommentVerdict,
} from "../src/ingest/github/comment-verdict.ts";
import { deriveVerdictIntegrityWarnings } from "../src/ingest/github/derive.ts";
import { deriveApprovedHeadShas, deriveChangesRequestedBy } from "../src/ingest/github/derive.ts";
import type {
  GitHubCommentObservation,
  GitHubPullRequestObservation,
} from "../src/ingest/github/types.ts";

const HEAD = "42ea13c260a8e8952f8dc044e4ac20a6dcfc60e5";
const OTHER = "8de3b8c7c5eb709e4a1038cf35c398234559f9f3f".slice(0, 40);

const REVIEWER = "chatgpt-independent-session";
const IMPLEMENTER = "claude-implementation-session";

/** A PR whose handoff names who implemented it, so self-review can be recognised. */
const BODY = `# Implementation Handoff\n\nImplementation actor: ${IMPLEMENTER}\n`;

const APPROVAL = `Looks right to me.

Build OS review verdict: Approved
Reviewed head: ${HEAD}
Review actor: ${REVIEWER}
Implementation actor reviewed: ${IMPLEMENTER}`;

/** The same approval with no actor named — a verdict on the record, but not gate-clearing. */
const ANONYMOUS_APPROVAL = `Build OS review verdict: Approved\nReviewed head: ${HEAD}`;

function comment(overrides: Partial<GitHubCommentObservation> = {}): GitHubCommentObservation {
  return {
    id: 1,
    author: "rae",
    body: APPROVAL,
    createdAt: "2026-08-25T12:00:00Z",
    htmlUrl: "https://github.com/50thycal/build-os/pull/9#issuecomment-1",
    ...overrides,
  };
}

function pr(overrides: Partial<GitHubPullRequestObservation> = {}): GitHubPullRequestObservation {
  return {
    number: 9,
    title: "Test",
    state: "open",
    draft: false,
    merged: false,
    createdAt: "2026-08-24T00:00:00Z",
    updatedAt: "2026-08-25T12:00:00Z",
    headRef: "claude/x",
    headSha: HEAD,
    baseRef: "main",
    author: "50thycal",
    authorIsBot: false,
    body: BODY,
    htmlUrl: "https://github.com/50thycal/build-os/pull/9",
    requestedReviewers: [],
    reviews: [],
    checks: [],
    ...overrides,
  };
}

describe("what counts as a verdict", () => {
  it("reads an approving verdict and the head it names", () => {
    expect(parseCommentVerdict(APPROVAL)).toEqual({
      verdict: "APPROVED",
      reviewedHead: HEAD,
      actor: REVIEWER,
      reviewedImplementationActor: IMPLEMENTER,
    });
  });

  it("reads changes required, and the protocol's other spellings", () => {
    const body = `Build OS review verdict: Changes required\nReviewed head: ${HEAD}`;
    expect(parseCommentVerdict(body)?.verdict).toBe("CHANGES_REQUIRED");

    const followUps = `**Build OS review verdict:** Approved with follow-ups\n**Reviewed head:** \`${HEAD}\``;
    expect(parseCommentVerdict(followUps)).toEqual({
      verdict: "APPROVED_WITH_FOLLOW_UPS",
      reviewedHead: HEAD,
    });
  });

  it("is case-insensitive about the marker and the SHA", () => {
    const body = `BUILD OS REVIEW VERDICT: approved\nREVIEWED HEAD: ${HEAD.toUpperCase()}`;
    expect(parseCommentVerdict(body)).toEqual({ verdict: "APPROVED", reviewedHead: HEAD });
  });
});

describe("what must never count as a verdict", () => {
  it("ignores an ordinary comment that talks about approving", () => {
    expect(parseCommentVerdict("This looks approved to me, ship it.")).toBeUndefined();
    expect(parseCommentVerdict(`Approved. Reviewed head: ${HEAD}`)).toBeUndefined();
  });

  it("ignores a verdict with no head — the whole point is naming the commit", () => {
    expect(parseCommentVerdict("Build OS review verdict: Approved")).toBeUndefined();
  });

  it("refuses an abbreviated SHA, as a workstream file does", () => {
    const body = "Build OS review verdict: Approved\nReviewed head: 42ea13c";
    expect(parseCommentVerdict(body)).toBeUndefined();
  });

  it("ignores a quoted verdict — quoting an approval is not issuing one", () => {
    const body = `> Build OS review verdict: Approved\n> Reviewed head: ${HEAD}\n\nI disagree with this.`;
    expect(parseCommentVerdict(body)).toBeUndefined();
  });

  it("ignores a verdict inside a fenced block, which is documentation", () => {
    const body = `Write it like this:\n\n\`\`\`\nBuild OS review verdict: Approved\nReviewed head: ${HEAD}\n\`\`\`\n`;
    expect(parseCommentVerdict(body)).toBeUndefined();
  });

  it("ignores a verdict inside an HTML comment", () => {
    const body = `<!--\nBuild OS review verdict: Approved\nReviewed head: ${HEAD}\n-->`;
    expect(parseCommentVerdict(body)).toBeUndefined();
  });

  it("ignores a verdict word outside the protocol's five", () => {
    const body = `Build OS review verdict: Looks great\nReviewed head: ${HEAD}`;
    expect(parseCommentVerdict(body)).toBeUndefined();
  });

  it("does not let a second block's head attach to the first block's verdict", () => {
    // The first marker has no head of its own; the head below belongs to the marker after it.
    const body = [
      "Build OS review verdict: Approved",
      "",
      "Build OS review verdict: Changes required",
      `Reviewed head: ${HEAD}`,
    ].join("\n");
    expect(parseCommentVerdict(body)).toBeUndefined();
  });

  it("reads the table form of a workstream file as prose, not as a verdict", () => {
    // This project's own PR comments quote that table. None of them is a verdict.
    const body = `| PR | Verdict | Reviewed head |\n|---|---|---|\n| #7 | Approved | ${HEAD} |`;
    expect(parseCommentVerdict(body)).toBeUndefined();
  });
});

describe("a comment verdict is a position of the same standing as a review", () => {
  it("clears the head a review could not, when GitHub allowed no review", () => {
    const observation = pr({ comments: [comment()] });
    expect(deriveApprovedHeadShas(observation)).toEqual([HEAD]);
    expect(deriveChangesRequestedBy(observation)).toEqual([]);
  });

  it("closes the gate when the comment objects", () => {
    const body = `Build OS review verdict: Changes required\nReviewed head: ${HEAD}`;
    const observation = pr({ comments: [comment({ body })] });
    expect(deriveApprovedHeadShas(observation)).toEqual([]);
    expect(deriveChangesRequestedBy(observation)).toEqual(["rae"]);
  });

  it("lets a later comment replace the same author's earlier review", () => {
    const observation = pr({
      reviews: [
        {
          id: 1,
          author: "rae",
          state: "APPROVED",
          submittedAt: "2026-08-25T10:00:00Z",
          htmlUrl: "u",
          commitId: HEAD,
        },
      ],
      comments: [
        comment({ body: `Build OS review verdict: Changes required\nReviewed head: ${HEAD}` }),
      ],
    });
    expect(deriveApprovedHeadShas(observation)).toEqual([]);
    expect(deriveChangesRequestedBy(observation)).toEqual(["rae"]);
  });

  it("lets a later review replace the same actor's earlier comment", () => {
    // The comment names `rae` as its actor and a GitHub review's actor is its login, so these
    // are one reviewer speaking twice through two transports — not two reviewers.
    const observation = pr({
      reviews: [
        {
          id: 1,
          author: "rae",
          state: "CHANGES_REQUESTED",
          submittedAt: "2026-08-25T13:00:00Z",
          htmlUrl: "u",
          commitId: HEAD,
        },
      ],
      comments: [
        comment({
          body: `Build OS review verdict: Approved\nReviewed head: ${HEAD}\nReview actor: rae`,
        }),
      ],
    });
    expect(deriveApprovedHeadShas(observation)).toEqual([]);
    expect(deriveChangesRequestedBy(observation)).toEqual(["rae"]);
  });

  it("keeps one reviewer's objection alive against another's approving comment", () => {
    const observation = pr({
      reviews: [
        {
          id: 1,
          author: "sam",
          state: "CHANGES_REQUESTED",
          submittedAt: "2026-08-25T09:00:00Z",
          htmlUrl: "u",
          commitId: HEAD,
        },
      ],
      comments: [comment()],
    });
    expect(deriveApprovedHeadShas(observation)).toEqual([HEAD]);
    expect(deriveChangesRequestedBy(observation)).toEqual(["sam"]);
  });

  it("approves only the head it names, never a later one", () => {
    const observation = pr({ headSha: OTHER, comments: [comment()] });
    expect(deriveApprovedHeadShas(observation)).toEqual([HEAD]);
    expect(deriveApprovedHeadShas(observation)).not.toContain(OTHER);
  });

  it("says nothing when comments were never read", () => {
    // `undefined` is "not read", which must not read as "read, and there were none".
    expect(deriveApprovedHeadShas(pr())).toEqual([]);
    expect(commentVerdicts(undefined)).toEqual([]);
  });

  it("orders verdicts oldest first regardless of the order they arrive in", () => {
    const later = comment({ id: 2, createdAt: "2026-08-25T14:00:00Z" });
    const earlier = comment({ id: 3, createdAt: "2026-08-25T08:00:00Z" });
    expect(commentVerdicts([later, earlier]).map((p) => p.at)).toEqual([
      "2026-08-25T08:00:00Z",
      "2026-08-25T14:00:00Z",
    ]);
  });
});

describe("one GitHub account, several actors", () => {
  /**
   * The case this whole form exists for, and the one it got wrong first.
   *
   * In a single-account repository the owner, the implementation agent and the independent
   * reviewer all post as the same login. Keyed on the login they are one reviewer, so whoever
   * spoke last silently overwrites the others — an implementation agent's own position could
   * supersede an independent reviewer's for no reason but sharing a pipe.
   */
  const verdict = (v: string, actor: string) =>
    `Build OS review verdict: ${v}\nReviewed head: ${HEAD}\nReview actor: ${actor}\n` +
    `Implementation actor reviewed: ${IMPLEMENTER}`;

  it("does not let one actor's later verdict overwrite another's", () => {
    const observation = pr({
      comments: [
        comment({
          id: 1,
          author: "50thycal",
          createdAt: "2026-08-25T10:00:00Z",
          body: verdict("Changes required", REVIEWER),
        }),
        comment({
          id: 2,
          author: "50thycal",
          createdAt: "2026-08-25T11:00:00Z",
          body: verdict("Approved", "owner-calvin"),
        }),
      ],
    });

    // Same login, two actors, two live positions. The objection survives the later approval.
    expect(deriveChangesRequestedBy(observation)).toEqual([REVIEWER]);
    expect(deriveApprovedHeadShas(observation)).toEqual([HEAD]);
  });

  it("still collapses one actor speaking twice", () => {
    const observation = pr({
      comments: [
        comment({ id: 1, createdAt: "2026-08-25T10:00:00Z", body: verdict("Changes required", REVIEWER) }),
        comment({ id: 2, createdAt: "2026-08-25T11:00:00Z", body: verdict("Approved", REVIEWER) }),
      ],
    });
    expect(deriveChangesRequestedBy(observation)).toEqual([]);
    expect(deriveApprovedHeadShas(observation)).toEqual([HEAD]);
  });

  it("reports objections by actor, so two through one account are two", () => {
    const observation = pr({
      comments: [
        comment({ id: 1, author: "50thycal", body: verdict("Changes required", REVIEWER) }),
        comment({ id: 2, author: "50thycal", body: verdict("Changes required", "owner-calvin") }),
      ],
    });
    expect(deriveChangesRequestedBy(observation)).toEqual(["owner-calvin", REVIEWER].sort());
  });
});

describe("independence is established by the record or not at all", () => {
  it("does not clear the gate on a verdict that names no actor", () => {
    // Still a verdict on the record — it displaces an earlier position by the same login and an
    // objection would still close the gate. It just cannot be the evidence of independent review.
    const observation = pr({ comments: [comment({ body: ANONYMOUS_APPROVAL })] });
    expect(parseCommentVerdict(ANONYMOUS_APPROVAL)?.verdict).toBe("APPROVED");
    expect(deriveApprovedHeadShas(observation)).toEqual([]);
  });

  it("does not clear the gate when the reviewer is the actor that implemented it", () => {
    const observation = pr({
      comments: [
        comment({
          body: `Build OS review verdict: Approved\nReviewed head: ${HEAD}\nReview actor: ${IMPLEMENTER}`,
        }),
      ],
    });
    expect(deriveApprovedHeadShas(observation)).toEqual([]);
  });

  it("ignores case when comparing the two actors", () => {
    const observation = pr({
      comments: [
        comment({
          body: `Build OS review verdict: Approved\nReviewed head: ${HEAD}\nReview actor: ${IMPLEMENTER.toUpperCase()}`,
        }),
      ],
    });
    expect(deriveApprovedHeadShas(observation)).toEqual([]);
  });

  it("does not clear the gate when the verdict omits the implementation actor it reviewed", () => {
    // Unknown independence must not read as approved. The pair has to be *in the artifact*: a
    // verdict that names only its own actor cannot say who it believed it was reviewing.
    const body = `Build OS review verdict: Approved\nReviewed head: ${HEAD}\nReview actor: ${REVIEWER}`;
    expect(parseCommentVerdict(body)?.reviewedImplementationActor).toBeUndefined();
    expect(deriveApprovedHeadShas(pr({ comments: [comment({ body })] }))).toEqual([]);
  });

  it("clears on the verdict's own pair even when the PR body declares nothing", () => {
    // The body is a cross-check, not the authority — precisely because it is editable after the
    // fact. A complete pair inside the verdict is what the gate rests on.
    const observation = pr({
      body: "# Implementation Handoff\n\nNo actor named.\n",
      comments: [comment()],
    });
    expect(deriveApprovedHeadShas(observation)).toEqual([HEAD]);
  });

  it("still closes the gate on an objection from an actor that could not open it", () => {
    const observation = pr({
      comments: [
        comment({
          body: `Build OS review verdict: Changes required\nReviewed head: ${HEAD}\nReview actor: ${IMPLEMENTER}`,
        }),
      ],
    });
    expect(deriveChangesRequestedBy(observation)).toEqual([IMPLEMENTER]);
  });

  it("reads the implementation actor out of the PR body, ignoring quotes and fences", () => {
    expect(implementationActor(BODY)).toBe(IMPLEMENTER);
    expect(implementationActor("**Implementation actor:** someone-else")).toBe("someone-else");
    expect(implementationActor("> Implementation actor: quoted")).toBeUndefined();
    expect(implementationActor("```\nImplementation actor: fenced\n```")).toBeUndefined();
    expect(implementationActor(undefined)).toBeUndefined();
  });
});

describe("evidence that moved after it was given", () => {
  /**
   * The gate's premise is that a verdict is a statement about one commit, fixed when it was
   * made. But a comment is editable and the PR body is editable, so evidence *can* move while
   * the commit it names stays put — and an approval could be written after the fact.
   */
  const approval = (actor = REVIEWER, implementer = IMPLEMENTER) =>
    `Build OS review verdict: Approved\nReviewed head: ${HEAD}\nReview actor: ${actor}\n` +
    `Implementation actor reviewed: ${implementer}`;

  const edited = (body: string): GitHubCommentObservation =>
    comment({ body, createdAt: "2026-08-25T12:00:00Z", updatedAt: "2026-08-27T09:00:00Z" });

  it("refuses an approving comment that was edited after posting", () => {
    const observation = pr({ comments: [edited(approval())] });
    expect(deriveApprovedHeadShas(observation)).toEqual([]);
  });

  it("says why, rather than going quiet about it", () => {
    const warnings = deriveVerdictIntegrityWarnings(pr({ comments: [edited(approval())] }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("edited");
    expect(warnings[0]).toContain(REVIEWER);
  });

  it("still closes the gate on an edited objection", () => {
    // Refusing to open on doubtful evidence and refusing to close on it are not symmetric.
    // An objection someone tampered with is still an objection on the record.
    const body =
      `Build OS review verdict: Changes required\nReviewed head: ${HEAD}\n` +
      `Review actor: ${REVIEWER}\nImplementation actor reviewed: ${IMPLEMENTER}`;
    expect(deriveChangesRequestedBy(pr({ comments: [edited(body)] }))).toEqual([REVIEWER]);
  });

  it("does not fault an unedited comment, or one from before edits were read", () => {
    expect(deriveVerdictIntegrityWarnings(pr({ comments: [comment()] }))).toEqual([]);
    // `updatedAt` absent — an observation captured before this field was read. Treated as
    // unedited rather than retroactively voiding evidence that was probably fine.
    const legacy = comment({ body: approval(), updatedAt: undefined });
    expect(deriveApprovedHeadShas(pr({ comments: [legacy] }))).toEqual([HEAD]);
  });

  it("does not let a later PR-body edit turn a self-review into an independent one", () => {
    // The attack the immutable pair exists to stop: a verdict where reviewer and implementer are
    // the same is non-clearing, and editing the body afterwards must not change that.
    const selfReview = comment({ body: approval(IMPLEMENTER, IMPLEMENTER) });
    const rewritten = pr({
      body: "# Implementation Handoff\n\nImplementation actor: someone-else\n",
      comments: [selfReview],
    });
    expect(deriveApprovedHeadShas(rewritten)).toEqual([]);
  });

  it("fails closed when the body contradicts what the verdict says it reviewed", () => {
    const observation = pr({
      body: "# Implementation Handoff\n\nImplementation actor: someone-else\n",
      comments: [comment()],
    });
    expect(deriveApprovedHeadShas(observation)).toEqual([]);

    const warnings = deriveVerdictIntegrityWarnings(observation);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(IMPLEMENTER);
    expect(warnings[0]).toContain("someone-else");
  });

  it("keeps a verdict clearing when the body agrees, whatever its case", () => {
    const observation = pr({
      body: `# Implementation Handoff\n\nImplementation actor: ${IMPLEMENTER.toUpperCase()}\n`,
      comments: [comment()],
    });
    expect(deriveVerdictIntegrityWarnings(observation)).toEqual([]);
    expect(deriveApprovedHeadShas(observation)).toEqual([HEAD]);
  });
});
