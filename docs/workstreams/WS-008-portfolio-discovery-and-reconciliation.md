# WS-008 — Real-portfolio discovery and reconciliation truth

**Phase:** BUILDING
**Status:** Active
**Created:** 2026-08-28
**Updated:** 2026-08-28
**Build OS:** v0.5

## Goal

Make the Companion a trustworthy control surface for the owner's whole active GitHub portfolio:
discover the repositories he is actually working in, and make every card's stated current state
either true or an explicit integrity finding — never a stale sentence that reads as current.

## Context

The framework work is finished; this workstream is the first pass of dogfooding the application
against real activity. Running the feed against the owner's real account exposed five defect
classes, each with a distinct root cause. They are recorded here because the causes, not the
symptoms, are what this workstream is fixing.

**1. Only two repositories are visible.** There is no discovery path at all. `companion.config.json`
is a hand-written allowlist of `50thycal/party-games` and `50thycal/build-os`, and
`applyConfig()` disables every project not in it. The feed was never narrow by accident — the
list *is* the rule.

**2. Merged pull requests read as awaiting review.** `describePullRequest` in `src/feed/cards.ts`
renders `describeCi(...) + describeReview(...)` for every pull request regardless of lifecycle,
so a merged PR with no reviews reports `checks green, no review yet` as its *current* state.
`PullRequestState` also carries no `mergedAt`/`closedAt`, so a lifecycle-aware sentence had
nothing to say when it happened.

**3. Event collapsing concatenates lifecycle events.** `summarizeChange` appends `Also: <older
event>` for any collapsed event at `NOTABLE` or above, without asking whether the headline
already implies it. `PR #146 merged. Also: PR #146 opened.` is the predictable output.

**4. Workstream cards contradict themselves.** Three separate sources of the contradiction:
`WORKSTREAM_CREATED` bakes the phase at first sight into its summary text (`WS-003 — … (READY_TO_BUILD)`),
which is then rendered as if current; `pickHeadlineEvent` ranks by importance before recency,
so an older `WORKSTREAM_BLOCKED` can outrank the newer transition that resolved it; and
`checkStateAgreement` in `src/projection/review-gate.ts` only detects the `REVIEW`-with-settled-PRs
case, so a workstream sitting in `READY_TO_BUILD`/`BLOCKED` while its implementation PR is
already merged produced no finding at all.

**5. `Needs Me` sends the owner on stale errands.** Integrity warnings are emitted as a single
`LOW` project item, and `Needs Me` shows `MEDIUM` and above — so a durable-vs-observed
contradiction, the most valuable thing the Companion can say, was structurally incapable of
reaching the screen it belongs on. Separately, a `BLOCKED` workstream's blocker text is
reported verbatim even when it names a pull request that has since merged.

## Current Mental Model

The Companion is a reconciliation engine. Three layers, and the precedence between them is
explicit rather than "whichever sentence sounds newest":

```text
  declared (Build OS artifacts)        observed (GitHub)
  phase, status, goal, next step       PR lifecycle, CI, reviews, merge time
  open decisions, review records       repository activity
            |                                   |
            +---------------+-------------------+
                            v
                     reconciliation
                            |
        +-------------------+--------------------+
        v                                        v
  owner-facing state                     integrity findings
  (each field from the layer             (the two layers disagree;
   that owns it, never merged)            reported, never resolved)
```

Ownership, per field:

- **Phase, status, goal, next step, open decisions** are owned by the durable artifact. GitHub
  cannot promote a workstream, and the Companion must never invent a phase the owner did not
  write.
- **Pull request lifecycle, CI, review, merge time, mergeability** are owned by GitHub. The
  workstream file's prose about a PR is a claim, not the state.
- **Disagreement between them is a third output**, not a tiebreak. A workstream that says
  `READY_TO_BUILD / blocked awaiting implementation` while its implementation PR is merged
  produces a finding that says exactly that, at a severity that reaches `Needs Me`.

Repository discovery is a rolling 60-day window over attributable owner activity:

```text
  every repo the credentials can read (paginated, private included)
        |  pushed_at >= now - 60d
        v
  owner attribution in the window
        1. owner-authored commits         -> eligible
        2. owner-authored/updated PRs     -> eligible
        3. neither                        -> eligible only if not a fork and not archived
        v
  eligible + pinned repositories = followed
  previously discovered, now outside the window -> disabled, history retained
```

## Decisions Made

- **Discovery replaces the allowlist; the config file becomes pins and overrides.** A repository
  listed in `companion.config.json` is always followed regardless of activity; everything else
  arrives from discovery. This keeps the escape hatch (a dormant repo the owner still wants
  watched, a path override) without the list being the rule.
- **Attribution outranks `pushed_at`.** `pushed_at` moves for reasons that are not the owner
  working — an upstream sync on a fork, a bot commit. It is a documented fallback, never the
  primary signal, and it is not enough on its own for a fork or an archived repository.
- **Archived and forked repositories need attributed activity.** Neither is excluded outright:
  owner commits or owner PRs in the window make either eligible, because a fork the owner is
  actually committing to is a project.
- **Aging out disables, never deletes.** A repository that leaves the window keeps its rows and
  its history and stops being synced, exactly as a de-configured project already did.
- **A contradiction is a finding, not a correction.** No code path in this workstream may write
  a durable phase the artifact does not state, or suppress a sentence to make a card agree with
  itself.

## Open Decisions

None outstanding for this workstream. The discovery policy above is the starting rule the owner
asked for; whether 60 days is the right window is answerable only after living with it.

## Assumptions

- The configured GitHub token can list private repositories. Where it cannot, private repos are
  simply absent — discovery reports what it could see rather than failing.
- `GET /repos/{repo}/commits?author={login}` attributes by commit author, which on this account
  covers agent-authored commits pushed under the owner's identity. That is intended: those are
  the owner's projects moving.

## Non-Goals

- Agent session checkpoints (WS-004). Observations collected, scope unchanged.
- Podcast rendering (WS-006). Still blocked on the written representation being trustworthy.
- Per-repository credentials. One token, as today.

## Build Card

Approved and inlined in the Context and Mental Model above: the five defect classes, their root
causes, the precedence model, and the discovery rule. Implementation follows those directly.

## What this pass says about the other workstreams

Phases are the owner's to set. These are findings, not moves.

| Workstream | Finding |
|---|---|
| **WS-001** — domain + event ledger | **Can close on the owner's confirmation.** Every reconstruction case held: a pull request opened, updated, reviewed and merged rebuilds to `MERGED` with its merge time; one closed without merging is unmistakably distinct; a workstream through several phase changes keeps the latest as canonical with the earlier ones subordinate; a durable record disagreeing with GitHub reconstructs *both* sides plus the finding; and a newly eligible repository backfills its window and nothing else. The only change the ledger needed was `mergedAt`/`closedAt` on the projection — a missing fact, not a broken model. |
| **WS-002** — GitHub feed MVP | **Not closeable on rendering; closeable on coverage once the owner has run it.** This is where the blocking defect was, and discovery, pagination, lifecycle summaries, collapsing and project grouping are all now in. What cannot be asserted from inside the repository is the thing the workstream is actually about: whether the feed represents the owner's real portfolio. That needs one run against their token. |
| **WS-003** — Build OS workstream integration | **Can close on the owner's confirmation.** The Party Games contradiction is now a finding rather than three sentences competing on one card, and the precedence model it needed is written down in `ARCHITECTURE.md` rather than implied. |
| **WS-005** — attention engine + catch-up briefing | **Half closeable.** `Needs Me` no longer sends the owner after a merged prerequisite and no longer hides contradictions below its own threshold. The *catch-up briefing* half is not done: the fact pack is still assembled per project, and across a dozen projects that is a dozen briefings rather than one. Recorded below as WS-010 rather than expanded into this pull request. |
| **WS-007** — owner-facing application | **Owner's call, and not yet.** The application now groups a portfolio instead of listing two repositories, but "something I could check each morning" is a judgement only made by checking it each morning. |
| **WS-004** — agent session checkpoint protocol | Unchanged, and confirmed as the next real capability. Dogfooding made the gap concrete: for every card the Companion can say what the record claims and what GitHub observed, and for none of them can it say what a session was doing when it stopped. The two sources it has are both *outcomes*; a stalled session leaves no outcome at all, so it is invisible rather than merely unexplained. |
| **WS-006** — podcast renderer | Stays blocked. The written representation improved but has not been used in anger once. |

## New workstreams this pass should produce

Recorded rather than built, so this pull request stays reviewable.

- **WS-009 — portfolio-scale sync budget.** The cost model changed with the follow set. One
  repository's cycle is roughly five requests per touched pull request, and thirteen repositories
  make a first sync expensive enough to matter against an hourly rate limit. This pass bounds it
  with a backfill floor at the discovery window and by paginating on the update cursor, which is
  enough to be correct and not enough to be a strategy. Wanted: per-project budgets, staggered
  scheduling, and a visible answer when a cycle was cut short.
- **WS-010 — cross-project catch-up.** The fact pack answers "what happened in this project".
  After a day away across a portfolio the question is "what happened, anywhere, that I should care
  about" — one briefing, ranked across projects, not one per repository.

## Implementation State

Building. Implementation PR: see Review State.

## Review State

**Verdict:** Not started
**Reviewed head:** —
**Reviewed PR:** —
**Finalization:** —
