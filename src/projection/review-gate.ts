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
  isAcceptingVerdict,
  isApprovingVerdict,
  objectionLabel,
  participatesInReviewGate,
  reviewRecordFor,
} from "../domain/state.ts";
import type {
  IntegrityWarning,
  OperatingMode,
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
 * True when a current position on the PR verifies this exact commit, and nobody objects.
 *
 * Both halves matter: a withdrawn approval is not evidence, and someone else's objection outranks
 * anyone's approval. What counts as verification depends on the mode — an approving review in a
 * `reviewed` project, and in a `solo` one the owner's acceptance as well.
 */
function currentHeadVerifiedOnGitHub(
  pr: PullRequestState,
  sha: string,
  options: ReviewGateOptions,
): boolean {
  if (pr.changesRequestedBy.length > 0) return false;
  if (pr.approvedHeadShas.includes(sha)) return true;
  /**
   * In a `solo` project the owner's acceptance is what verifies the final head, because the
   * approving review this otherwise waits for is precisely the artifact such a project has
   * declared it cannot produce. Requiring it there would leave the check permanently unsatisfied
   * — a finding that can never be cleared teaches its reader to ignore the whole class.
   */
  return isSolo(options) && pr.ownerAcceptances.some((acceptance) => acceptance.head === sha);
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
  /**
   * The project's declared operating mode (Build OS v0.8). Absent means it declares none, which
   * the parse contract reads as `reviewed` — the stricter of the two, and the safe default for a
   * project that has never considered the question.
   */
  operatingMode?: OperatingMode;
}

/**
 * Is this a project that has declared it has no independent reviewer?
 *
 * Only a declaration counts. A project is never `solo` because its pull requests happen to carry
 * no reviews — that is the shape of an unreviewed `reviewed` project, and reading it as `solo`
 * would silently excuse exactly the thing the gate exists to report.
 */
function isSolo(options: ReviewGateOptions): boolean {
  return options.operatingMode === "solo";
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
      /**
       * Mutated evidence is reported for every linked PR, gated or not.
       *
       * It is a fact about the record rather than a judgement about this workstream's process:
       * a verdict was altered after it was given. That is worth seeing even on a PR the gate
       * otherwise makes no claim about.
       */
      for (const detail of pr.mutatedEvidence) {
        warnings.push({
          code: "REVIEW_EVIDENCE_MUTATED",
          workstreamId: ws.workstreamId,
          message: `PR #${pr.number}: ${detail}`,
          sources: [pr.source],
        });
      }

      const record = reviewRecordFor(ws.reviewRecords, pr.number);
      if (record) {
        warnings.push(...checkRecord(ws, pr, record, options));
      } else if (expectsRecord(ws, pr, options)) {
        warnings.push(...checkMissingRecord(ws, pr, options));
      }
      // Otherwise this PR is outside the gate — pre-adoption work, a finished workstream, or one
      // that never reached a Build Card. It makes no claim about this PR and neither do we.
    }

    warnings.push(...checkStateAgreement(ws, linked));
  }

  return warnings;
}

function checkMissingRecord(
  ws: WorkstreamState,
  pr: PullRequestState,
  options: ReviewGateOptions,
): IntegrityWarning[] {
  const sources = [ws.source, pr.source];

  if (pr.lifecycle === "MERGED") {
    return [
      {
        code: "MERGED_WITHOUT_APPROVAL",
        workstreamId: ws.workstreamId,
        message:
          `PR #${pr.number} is merged and ${ws.workstreamId} records no verdict for it. Under ` +
          `Build OS ${ws.protocolVersion ?? "v0.5"} a significant PR merges only on ` +
          `${isSolo(options) ? "an approved verdict or a recorded Owner-accepted" : "an approved verdict"} ` +
          `naming its merged head. Declaring solo replaces the reviewer, not the record.`,
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
  options: ReviewGateOptions,
): IntegrityWarning[] {
  const warnings: IntegrityWarning[] = [];
  const sources = [ws.source, pr.source];
  const solo = isSolo(options);
  const ownerAccepted = record.verdict === "OWNER_ACCEPTED";

  /**
   * The mode says an independent actor was available and the record says the owner accepted
   * instead. That is a missing review, not a substitute for one — so it is reported here *and*
   * the verdict clears nothing below, which is what makes this finding mean something rather
   * than sit alongside a gate it did not affect.
   */
  if (ownerAccepted && !solo) {
    warnings.push({
      code: "OWNER_ACCEPTED_IN_REVIEWED_MODE",
      workstreamId: ws.workstreamId,
      message:
        `${ws.workstreamId} records Owner-accepted for PR #${pr.number}, but the project ` +
        `${options.operatingMode ? `declares operating mode ${options.operatingMode}` : "declares no operating mode, which means reviewed"}. ` +
        `An acceptance is not an approval. Either get the review the mode says is available, or ` +
        `declare the project solo if no independent reviewer genuinely exists.`,
      sources,
    });
  }

  /**
   * The file claims a verdict and the pull request records none at all.
   *
   * This is `DEC-023`'s failure made visible: a merge-finalization commit that pre-wrote the
   * value it expected to receive. Because the commit lands before the verdict it anticipates,
   * the claim survives whether or not that verdict ever arrives — and from inside the file it
   * looks identical either way. Only a consumer holding both sides can tell them apart.
   *
   * Deliberately narrow: it fires only when the PR carries **no** position of any kind, so a
   * real verdict that merely fails to clear the gate is never called a fabrication.
   */
  if (isAcceptingVerdict(record.verdict) && pr.recordedPositions === 0) {
    warnings.push({
      code: "VERDICT_UNSUPPORTED",
      workstreamId: ws.workstreamId,
      message:
        `${ws.workstreamId} records ${record.verdict} for PR #${pr.number}, but that PR carries no ` +
        `review, comment verdict, or acceptance at all. The file is the only place this verdict ` +
        `exists. The usual cause is a finalization commit that wrote the verdict it expected ` +
        `rather than one it had.`,
      sources,
    });
  }

  /**
   * What this record can open, given the mode. In `solo` an acceptance stands where an approval
   * would; in `reviewed` it stands nowhere at all.
   */
  const clears = solo ? isAcceptingVerdict(record.verdict) : isApprovingVerdict(record.verdict);
  /**
   * An acceptance names its commit in its own field. Reading `reviewedHead` for it would be the
   * conflation v0.8 exists to prevent, and would quietly pass an acceptance whose own field was
   * never filled in.
   */
  const gateHead = ownerAccepted ? record.acceptedHead : record.reviewedHead;
  const headMatches = gateHead !== undefined && gateHead === pr.headSha;

  // A reviewer's outstanding objection on GitHub, against a workstream that says the work is
  // approved, is exactly the kind of contradiction this layer exists to surface. An acceptance
  // is a current position like any other, so an objection outranks it too.
  if (clears && pr.changesRequestedBy.length > 0) {
    warnings.push({
      code: "WORKSTREAM_PR_STATE_MISMATCH",
      workstreamId: ws.workstreamId,
      message:
        `${ws.workstreamId} records ${record.verdict} for PR #${pr.number}, but ` +
        `${pr.changesRequestedBy.map(objectionLabel).join(", ")} ` +
        `${pr.changesRequestedBy.length === 1 ? "has" : "have"} an outstanding changes request ` +
        `on GitHub. The gate stays closed until that is resolved.`,
      sources,
    });
  }

  // Finalization is only reachable from an approved record: it is the commit pushed *after*
  // approval and before merge. Declared without one, it is a step taken out of order — and it
  // must not be a way to reach the GitHub-evidence path that clears the final-head check.
  if (record.finalized && !clears && !solo) {
    warnings.push({
      code: "WORKSTREAM_PR_STATE_MISMATCH",
      workstreamId: ws.workstreamId,
      message:
        `${ws.workstreamId} declares finalization pushed on PR #${pr.number} while its verdict is ` +
        `${record.verdict ?? "absent"}. The finalization commit comes after approval, not before it.`,
      sources,
    });
  }

  if (clears && gateHead && !headMatches) {
    if (record.finalized) {
      // Expected divergence: the finalization commit moved the head past the reviewed one, and
      // by construction it could not name itself. The one thing GitHub evidence may clear: an
      // approval that is a reviewer's current position, naming the head that commit produced.
      if (currentHeadVerifiedOnGitHub(pr, pr.headSha, options)) return warnings;

      warnings.push({
        code: "FINAL_HEAD_UNVERIFIED",
        workstreamId: ws.workstreamId,
        message:
          `${ws.workstreamId} declares the finalization commit pushed on PR #${pr.number}, but ` +
          `${solo ? "neither an approving review nor an acceptance names" : "no approving review names"} ` +
          `its current head ${shortSha(pr.headSha)}. The full ${ownerAccepted ? "acceptance" : "review"} ` +
          `covered ${shortSha(gateHead)}; the final head still needs ` +
          `${solo ? "accepting" : "verifying"} on the PR.`,
        sources,
      });
    } else if (LIVE.has(pr.lifecycle)) {
      warnings.push({
        code: "REVIEW_STALE",
        workstreamId: ws.workstreamId,
        message:
          `${ws.workstreamId} ${ownerAccepted ? "accepted" : "approved"} ${shortSha(gateHead)} but PR ` +
          `#${pr.number} is now at ${shortSha(pr.headSha)}. The ` +
          `${ownerAccepted ? "acceptance" : "approval"} is against an older commit; ` +
          `${ownerAccepted ? "accept" : "re-review"} the current head.`,
        sources,
      });
    } else if (pr.lifecycle === "MERGED") {
      warnings.push({
        code: "MERGED_WITHOUT_APPROVAL",
        workstreamId: ws.workstreamId,
        message:
          `PR #${pr.number} merged at ${shortSha(pr.headSha)}, but ${ws.workstreamId} only ` +
          `${ownerAccepted ? "accepted" : "approved"} ${shortSha(gateHead)}. The merged commit was ` +
          `never ${ownerAccepted ? "accepted" : "reviewed"}.`,
        sources,
      });
    }
  }

  if (!clears && pr.lifecycle === "MERGED") {
    warnings.push({
      code: "MERGED_WITHOUT_APPROVAL",
      workstreamId: ws.workstreamId,
      message:
        `PR #${pr.number} is merged while ${ws.workstreamId} records verdict ` +
        `${record.verdict ?? "none"}. Merge requires ` +
        `${solo ? "an approved verdict or the owner's acceptance" : "an approved verdict"} naming ` +
        `the merged head.`,
      sources,
    });
  }

  return warnings;
}

/** Phases at which the implementation has not, by the workstream's own account, landed yet. */
const PRE_REVIEW_PHASES = new Set([
  "IDEA",
  "EXPLORE",
  "MODEL",
  "DECIDE",
  "BUILD_CARD",
  "READY_TO_BUILD",
  "BUILDING",
]);

/**
 * The v0.4 failure this closes: a workstream left saying `REVIEW` long after its PR merged, so the
 * durable record on main describes a state that no longer exists. Finalization is what moves it.
 *
 * Dogfooding added the harder half. `REVIEW` with settled PRs was the only shape detected, so a
 * workstream sitting at `READY_TO_BUILD` and `BLOCKED` — *behind* review — while its
 * implementation PR was already merged produced no finding at all. That is the more misleading
 * of the two: the first reports a step not taken, the second tells the owner to go and do work
 * that is already in the base branch.
 *
 * Every check here requires that *nothing linked is still open*. A workstream in `BUILDING` with
 * one merged design-only PR and one open implementation PR is not behind anything — it is
 * exactly where it says it is — and firing on it would make the finding worthless.
 */
function checkStateAgreement(ws: WorkstreamState, linked: PullRequestState[]): IntegrityWarning[] {
  if (linked.length === 0) return [];
  const warnings: IntegrityWarning[] = [];

  const settled = linked.every((pr) => pr.lifecycle === "MERGED" || pr.lifecycle === "CLOSED");
  const merged = linked.filter((pr) => pr.lifecycle === "MERGED");
  const complete = ws.phase === "COMPLETE" || ws.status === "COMPLETE";

  if (settled && merged.length > 0 && ws.phase && PRE_REVIEW_PHASES.has(ws.phase)) {
    const numbers = merged.map((pr) => `#${pr.number}`).join(", ");
    warnings.push({
      code: "WORKSTREAM_STATE_BEHIND_GITHUB",
      workstreamId: ws.workstreamId,
      message:
        `${ws.workstreamId} still records ${ws.phase}${ws.status ? ` / ${ws.status}` : ""}, but its linked work ` +
        `(${numbers}) has already merged and nothing linked is still open. The durable record is behind ` +
        `what GitHub shows; it has not been moved on since the merge.`,
      sources: [ws.source, ...merged.map((pr) => pr.source)],
    });
  }

  // A blocker that names a pull request by number, where that pull request has since merged.
  // The most literal form of "you are being asked to do something already done", and specific
  // enough that it replaces the general observation below rather than joining it.
  const named = namedPullRequests(ws.blocker ?? ws.nextStep);
  const done = linked.filter((pr) => pr.lifecycle === "MERGED" && named.includes(pr.number));

  if (ws.status === "BLOCKED" && done.length > 0) {
    for (const pr of done) {
      warnings.push({
        code: "BLOCKER_ALREADY_RESOLVED",
        workstreamId: ws.workstreamId,
        message:
          `${ws.workstreamId} waits on PR #${pr.number}, which merged${pr.mergedAt ? ` on ${pr.mergedAt.slice(0, 10)}` : ""}. ` +
          `The prerequisite this workstream names is already met.`,
        sources: [ws.source, pr.source],
      });
    }
  } else if (settled && merged.length > 0 && ws.status === "BLOCKED") {
    const numbers = merged.map((pr) => `#${pr.number}`).join(", ");
    warnings.push({
      code: "BLOCKER_ALREADY_RESOLVED",
      workstreamId: ws.workstreamId,
      message:
        `${ws.workstreamId} is marked BLOCKED — ${ws.blocker ?? "no reason recorded"} — while ${numbers} ` +
        `${merged.length === 1 ? "has" : "have"} merged. Either the blocker is stale or it is about something ` +
        `other than that work.`,
      sources: [ws.source, ...merged.map((pr) => pr.source)],
    });
  }

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

/** Pull request numbers mentioned in a sentence, so a stated prerequisite can be checked. */
function namedPullRequests(text: string | undefined): number[] {
  if (!text) return [];
  return [...text.matchAll(/#(\d{1,6})\b/g)].map((match) => Number(match[1]));
}
