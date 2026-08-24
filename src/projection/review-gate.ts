/**
 * Cross-source review-gate checks (Build OS v0.5).
 *
 * These are the only checks that need both sides of the story: the workstream file says what was
 * reviewed, GitHub says what actually exists. Neither source can produce them alone, which is why
 * they live in the projection layer rather than in the Build OS reconciler.
 *
 * Two rules shape everything below.
 *
 * **A verdict belongs to one PR.** A workstream may span several, and comparing one
 * workstream-level head against all of them reports an older merged PR as unapproved the moment
 * a newer one is approved. A PR with no record is a PR this workstream makes no claim about, and
 * silence is the correct output for it.
 *
 * **GitHub evidence closes the gate, and only narrowly opens it.** An approval that is no longer a
 * reviewer's current position is not evidence, and while any reviewer has an outstanding
 * `Changes required` the gate is shut regardless of who else approved. A current-head approval
 * clears exactly one thing — the head a finalization commit could not name — and only when the
 * workstream's own record for that PR is approving and declares finalization. It never overrides
 * a workstream that says `Changes required` or `In review`: that is a contradiction to report.
 *
 * **Participation is declared, not inferred, and it never reaches backwards.** Whether the gate
 * applies comes from the Build OS version a workstream declares, or — for work that is current —
 * from its project's pin. If absence of a review record were what made a workstream look legacy,
 * deleting the record would delete the gate; but if a project's upgrade to v0.5 silently claimed
 * every headerless file it inherited, adopting the version would retroactively condemn history
 * the migration rules promise to leave alone. Both failures are avoided by treating an inherited
 * pin as weaker than a declaration and by honouring the project's adoption boundary.
 *
 * **A commit cannot name itself.** The merge-finalization commit changes the head by existing, so
 * no SHA written inside it can be the head it produces. The workstream file therefore records the
 * last head reviewed *in full*, and the final head is verified on the PR — through GitHub's own
 * review record, which is stamped with a commit id after that commit exists.
 *
 * Every check reports. None repairs. A contradiction between durable records is the owner's to
 * resolve — a consumer that quietly picks a winner destroys the evidence that something went wrong.
 */

import {
  isApprovingVerdict,
  participatesInReviewGate,
  reviewRecordFor,
} from "../domain/state.ts";
import type {
  IntegrityWarning,
  PullRequestState,
  ReviewRecord,
  WorkstreamState,
} from "../domain/state.ts";

/** Lifecycles where the branch can still move under an approval. */
const LIVE = new Set(["OPEN", "DRAFT"]);

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * True when an approval that is still a reviewer's current position names this exact commit, and
 * no reviewer has an outstanding changes request. Both halves matter: a withdrawn approval is not
 * evidence, and someone else's objection outranks anyone's approval.
 */
function currentlyApprovedOnGitHub(pr: PullRequestState, sha: string): boolean {
  return pr.changesRequestedBy.length === 0 && pr.approvedHeadShas.includes(sha);
}

/**
 * Is this workstream far enough along that a PR of its own needs a review record?
 *
 * An approved Build Card is Build OS's own definition of significant work, and a workstream that
 * has reached implementation has one whether or not the section still says so.
 */
function isSignificant(ws: WorkstreamState): boolean {
  return (
    ws.buildCardReady ||
    ws.phase === "READY_TO_BUILD" ||
    ws.phase === "BUILDING" ||
    ws.phase === "REVIEW" ||
    ws.phase === "COMPLETE"
  );
}

export interface ReviewGateOptions {
  /**
   * When the project adopted its current Build OS version, as `YYYY-MM-DD`. Work created before
   * it belongs to the previous version. Absent, the gate stays conservative about anything
   * already settled — see `expectsRecord`.
   */
  adoptedAt?: string;
}

/**
 * Is this workstream itself finished? A completed or abandoned workstream is history. A project
 * that upgrades to v0.5 does not thereby claim its finished work was done under v0.5, and the
 * migration rules say completed workstreams are never rewritten.
 */
function isHistorical(ws: WorkstreamState): boolean {
  return ws.phase === "COMPLETE" || ws.status === "COMPLETE" || ws.status === "ABANDONED";
}

/**
 * Does the gate expect a review record for this particular PR?
 *
 * The two rules that must both survive:
 *
 * - **Current significant work cannot escape by deleting its record.** A workstream that declares
 *   v0.5, or an active one under a v0.5 project, owes a record for the PRs it links.
 * - **History is not re-judged.** A completed workstream, a workstream last touched before the
 *   project adopted v0.5, and a PR opened before that adoption and already settled are all
 *   outside the gate — whatever the project pin now says.
 *
 * A workstream's own `Build OS:` header is a statement about that workstream and is honoured in
 * both directions: it can bring one under the gate, and `v0.4` can keep one out.
 */
function expectsRecord(
  ws: WorkstreamState,
  pr: PullRequestState,
  options: ReviewGateOptions,
): boolean {
  if (!participatesInReviewGate(ws.protocolVersion)) return false;
  if (!isSignificant(ws)) return false;

  const declared = ws.protocolVersionSource === "WORKSTREAM";
  const settled = pr.lifecycle === "MERGED" || pr.lifecycle === "CLOSED";

  if (!declared) {
    // Inherited from the project pin. Weaker evidence, so it covers current work only.
    if (isHistorical(ws)) return false;
    if (options.adoptedAt && ws.updatedAt && ws.updatedAt < options.adoptedAt) return false;
    // With no adoption date there is no way to tell a pre-adoption merge from a post-adoption
    // one, and the safe answer for something already settled is silence.
    if (settled && !options.adoptedAt) return false;
  }

  // A PR opened before adoption and already settled is work from the previous version, even on a
  // workstream that has since come under v0.5. This is the multi-PR case: an old merged PR beside
  // a current reviewed one.
  if (settled && options.adoptedAt && pr.createdAt < options.adoptedAt) return false;

  return true;
}

export function checkReviewGate(
  workstreams: WorkstreamState[],
  pullRequests: PullRequestState[],
  options: ReviewGateOptions = {},
): IntegrityWarning[] {
  const warnings: IntegrityWarning[] = [];
  const byNumber = new Map(pullRequests.map((pr) => [pr.number, pr]));

  for (const ws of workstreams) {
    const linked = ws.relatedPrNumbers
      .map((n) => byNumber.get(n))
      .filter((pr): pr is PullRequestState => pr !== undefined);

    for (const pr of linked) {
      const record = reviewRecordFor(ws.reviewRecords, pr.number);
      if (record) {
        warnings.push(...checkRecord(ws, pr, record));
      } else if (expectsRecord(ws, pr, options)) {
        warnings.push(...checkMissingRecord(ws, pr));
      }
      // Otherwise this PR is outside the gate — pre-adoption work, a finished workstream, or one
      // that never reached a Build Card. It makes no claim about this PR and neither do we.
    }

    warnings.push(...checkStateAgreement(ws, linked));
  }

  return warnings;
}

function checkMissingRecord(ws: WorkstreamState, pr: PullRequestState): IntegrityWarning[] {
  const sources = [ws.source, pr.source];

  if (pr.lifecycle === "MERGED") {
    return [
      {
        code: "MERGED_WITHOUT_APPROVAL",
        workstreamId: ws.workstreamId,
        message:
          `PR #${pr.number} is merged and ${ws.workstreamId} records no verdict for it. Under ` +
          `Build OS ${ws.protocolVersion ?? "v0.5"} a significant PR merges only on an approved ` +
          `verdict naming its merged head.`,
        sources,
      },
    ];
  }

  if (pr.lifecycle === "CLOSED") return [];

  return [
    {
      code: "REVIEW_RECORD_MISSING",
      workstreamId: ws.workstreamId,
      message:
        `${ws.workstreamId} runs under Build OS ${ws.protocolVersion ?? "v0.5"} and links PR ` +
        `#${pr.number}, but records no verdict for it. The merge gate needs one before that PR ` +
        `can merge.`,
      sources,
    },
  ];
}

function checkRecord(
  ws: WorkstreamState,
  pr: PullRequestState,
  record: ReviewRecord,
): IntegrityWarning[] {
  const warnings: IntegrityWarning[] = [];
  const sources = [ws.source, pr.source];
  const approved = isApprovingVerdict(record.verdict);
  const headMatches = record.reviewedHead === pr.headSha;

  // A reviewer's outstanding objection on GitHub, against a workstream that says the work is
  // approved, is exactly the kind of contradiction this layer exists to surface.
  if (approved && pr.changesRequestedBy.length > 0) {
    warnings.push({
      code: "WORKSTREAM_PR_STATE_MISMATCH",
      workstreamId: ws.workstreamId,
      message:
        `${ws.workstreamId} records ${record.verdict} for PR #${pr.number}, but ` +
        `${pr.changesRequestedBy.join(", ")} ${pr.changesRequestedBy.length === 1 ? "has" : "have"} ` +
        `an outstanding changes request on GitHub. The gate stays closed until that is resolved.`,
      sources,
    });
  }

  // Finalization is only reachable from an approved record: it is the commit pushed *after*
  // approval and before merge. Declared without one, it is a step taken out of order — and it
  // must not be a way to reach the GitHub-evidence path that clears the final-head check.
  if (record.finalized && !approved) {
    warnings.push({
      code: "WORKSTREAM_PR_STATE_MISMATCH",
      workstreamId: ws.workstreamId,
      message:
        `${ws.workstreamId} declares finalization pushed on PR #${pr.number} while its verdict is ` +
        `${record.verdict ?? "absent"}. The finalization commit comes after approval, not before it.`,
      sources,
    });
  }

  if (approved && record.reviewedHead && !headMatches) {
    if (record.finalized) {
      // Expected divergence: the finalization commit moved the head past the reviewed one, and
      // by construction it could not name itself. The one thing GitHub evidence may clear: an
      // approval that is a reviewer's current position, naming the head that commit produced.
      if (currentlyApprovedOnGitHub(pr, pr.headSha)) return warnings;

      warnings.push({
        code: "FINAL_HEAD_UNVERIFIED",
        workstreamId: ws.workstreamId,
        message:
          `${ws.workstreamId} declares the finalization commit pushed on PR #${pr.number}, but no ` +
          `approving review names its current head ${shortSha(pr.headSha)}. The full review covered ` +
          `${shortSha(record.reviewedHead)}; the final head still needs verifying on the PR.`,
        sources,
      });
    } else if (LIVE.has(pr.lifecycle)) {
      warnings.push({
        code: "REVIEW_STALE",
        workstreamId: ws.workstreamId,
        message:
          `${ws.workstreamId} approved ${shortSha(record.reviewedHead)} but PR #${pr.number} is now at ` +
          `${shortSha(pr.headSha)}. The approval is against an older commit; re-review the current head.`,
        sources,
      });
    } else if (pr.lifecycle === "MERGED") {
      warnings.push({
        code: "MERGED_WITHOUT_APPROVAL",
        workstreamId: ws.workstreamId,
        message:
          `PR #${pr.number} merged at ${shortSha(pr.headSha)}, but ${ws.workstreamId} only approved ` +
          `${shortSha(record.reviewedHead)}. The merged commit was never reviewed.`,
        sources,
      });
    }
  }

  if (!approved && pr.lifecycle === "MERGED") {
    warnings.push({
      code: "MERGED_WITHOUT_APPROVAL",
      workstreamId: ws.workstreamId,
      message:
        `PR #${pr.number} is merged while ${ws.workstreamId} records verdict ` +
        `${record.verdict ?? "none"}. Merge requires an approved verdict naming the merged head.`,
      sources,
    });
  }

  return warnings;
}

/**
 * The v0.4 failure this closes: a workstream left saying `REVIEW` long after its PR merged, so the
 * durable record on main describes a state that no longer exists. Finalization is what moves it.
 */
function checkStateAgreement(ws: WorkstreamState, linked: PullRequestState[]): IntegrityWarning[] {
  if (linked.length === 0) return [];
  const warnings: IntegrityWarning[] = [];

  const settled = linked.every((pr) => pr.lifecycle === "MERGED" || pr.lifecycle === "CLOSED");
  const complete = ws.phase === "COMPLETE" || ws.status === "COMPLETE";

  if (ws.phase === "REVIEW" && settled) {
    const numbers = linked.map((pr) => `#${pr.number}`).join(", ");
    warnings.push({
      code: "WORKSTREAM_PR_STATE_MISMATCH",
      workstreamId: ws.workstreamId,
      message:
        `${ws.workstreamId} is still in REVIEW but every linked PR (${numbers}) is merged or closed. ` +
        `The merge-finalization step has not recorded the actual next phase.`,
      sources: [ws.source, ...linked.map((pr) => pr.source)],
    });
  }

  const stillLive = linked.filter((pr) => LIVE.has(pr.lifecycle));
  if (complete && stillLive.length > 0) {
    const numbers = stillLive.map((pr) => `#${pr.number}`).join(", ");
    warnings.push({
      code: "WORKSTREAM_PR_STATE_MISMATCH",
      workstreamId: ws.workstreamId,
      message:
        `${ws.workstreamId} is recorded COMPLETE but ${numbers} ${stillLive.length === 1 ? "is" : "are"} ` +
        `still open. Either the work is not finished or the PR was left behind.`,
      sources: [ws.source, ...stillLive.map((pr) => pr.source)],
    });
  }

  return warnings;
}
