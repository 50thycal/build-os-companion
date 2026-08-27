# Implementation Handoff

<!-- Copied from 50thycal/build-os templates/PR_HANDOFF.template.md at Build OS v0.5.
     Re-copy from canonical when Build OS changes it; do not edit it into a local variant. -->

<!-- This PR body is the authoritative handoff. Every section is required; sections with
     nothing to report say `None`. Keep it current if the PR changes. -->

**Workstream:** WS-### · **Build Card:** <link> · **Build Spec:** <link> · **Build OS v0.5**

## Goal

> After this change, the system should <quoted from the Build Card>.

## Implemented

<What behavior actually exists — not what was attempted.>

## Architecture / Flow

<How a request or event moves through the change. Which components participate, where
state changes, what happens on the unhappy path.>

```text

```

## Major Areas Changed

<!-- The shape of the change, not a file dump. The diff already lists every file. -->

- `<area>` — <what changed and why it matters>

## Design Decisions

<Technical decisions made during implementation, with reasoning.>

-

## Spec Deviations

<!-- Any departure from approved behavior or requirements, referencing OD-n / R-n / AC-n.
     Write `None` explicitly when there are none. If unsure whether something counts,
     it counts. -->

None

## Tests / Validation

<What was run, with actual results. What is covered and what is not.>

- `<command>` — <result>
- New tests: <what they cover>
- Not covered: <gaps>

## Known Risks / Limitations

<Concrete. Unhandled edges, behavior under load, assumptions that could prove wrong,
deploy risk.>

-

## Recommended Review Focus

<Where an independent reviewer should scrutinize. Name specific places.>

-

## Framework

<!-- Omit for small PRs. Never record a check that did not happen. -->

Framework:
- Project adopted: v0.x
- Canonical checked: v0.x
- Compatibility: current
<!-- or: upgrade required / Migration performed: <what> -->

## Review Gate

Implementation actor: <stable identifier for the agent or person who implemented this>

Review gate: Pending independent review

<!--
Written by the implementation agent, which never claims an approval it did not receive.
Until a reviewer records a verdict, this line reads exactly `Pending independent review`.

`Implementation actor` names who did the work, as distinct from the GitHub account that pushed
it — in a single-account repository they are not the same thing, and several actors share one
login. It is what lets a comment verdict be recognised as self-review rather than independent
approval. Omitting it does not make a review look independent; it makes every comment verdict
non-gate-clearing, because independence can no longer be established either way.

Once reviewed, repeat the verdict and the full 40-character head it was reached against:

    Review gate: Approved · reviewed head <40-char SHA>
    Head at time of writing: <40-char SHA> (current)

If the PR has moved since the verdict, say so — the approval is stale.

Before merge, push the **merge-finalization** commit to this same PR: documentation only —
the workstream file, `ACTIVE.md`, `Review State`, and where the workstream completes,
`PROJECT_MODEL.md` and `DECISIONS.md`. It sets them to what becomes true when this PR lands.
Any executable, test, dependency, config, or behavior-documentation change in that commit
reopens full review.

That commit cannot contain its own SHA, so it does not try to: `Reviewed head` keeps naming the
last fully-reviewed commit and gains `Finalization: pushed`. Say here that it is pushed; the
reviewer then verifies the head it produced and approves on the PR, and the merge targets that
exact SHA.

This agent does not approve this PR and does not merge it.
-->

## Workstream

<!-- ID, phase before → after, and whether this PR completes it. `None` if not applicable. -->

WS-### — <title>. <PHASE> → <PHASE>. <Completes / does not complete> the workstream.

## Follow-up Work

<Intentional deferrals, each with the reason. Not a parking lot for unfinished in-scope
work.>

-

## Owner Summary

<!-- ~100 words max. Plain language, no file or function names. What changed, what behaves
     differently, meaningful deviations, unresolved owner decisions. Put any unresolved
     decision in the first sentence. -->

<summary>
