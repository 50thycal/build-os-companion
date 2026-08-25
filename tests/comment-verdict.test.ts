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

import { commentVerdicts, parseCommentVerdict } from "../src/ingest/github/comment-verdict.ts";
import { deriveApprovedHeadShas, deriveChangesRequestedBy } from "../src/ingest/github/derive.ts";
import type {
  GitHubCommentObservation,
  GitHubPullRequestObservation,
} from "../src/ingest/github/types.ts";

const HEAD = "42ea13c260a8e8952f8dc044e4ac20a6dcfc60e5";
const OTHER = "8de3b8c7c5eb709e4a1038cf35c398234559f9f3f".slice(0, 40);

const APPROVAL = `Looks right to me.

Build OS review verdict: Approved
Reviewed head: ${HEAD}`;

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
    htmlUrl: "https://github.com/50thycal/build-os/pull/9",
    requestedReviewers: [],
    reviews: [],
    checks: [],
    ...overrides,
  };
}

describe("what counts as a verdict", () => {
  it("reads an approving verdict and the head it names", () => {
    expect(parseCommentVerdict(APPROVAL)).toEqual({ verdict: "APPROVED", reviewedHead: HEAD });
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

  it("lets a later review replace the same author's earlier comment", () => {
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
      comments: [comment()],
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
