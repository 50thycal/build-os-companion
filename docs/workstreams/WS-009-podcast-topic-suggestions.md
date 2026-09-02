# WS-009 — Podcast topic suggestions

**Phase:** BUILDING · **Status:** Active
**Created:** 2026-09-02 · **Updated:** 2026-09-02

## Goal

The Companion notices when a project has developed something worth understanding in depth, and
proposes an episode about it — which the owner then approves, keeps, or turns down. It never
makes one on its own.

## Context

WS-006 built the renderer: given a topic and the facts behind it, it produces a script. It
deliberately left open the question this workstream answers — *which* topics are worth an episode
— and said so in its own file. `docs/ideas/topic-podcast-suggestions.md` is the idea being built
here, captured in [#13](https://github.com/50thycal/build-os-companion/pull/13) before any of it
existed.

The distinction that makes it worth building at all:

- **Digest podcast:** what changed?
- **Topic podcast:** help me understand this.

A digest can be produced on a schedule because its selection question is trivial — everything
that happened. A topic episode cannot, because the whole value is in what gets left out.

## Current Mental Model

```text
project state ──► rules ──► candidates ──► score ──► above the bar? ──► the owner decides
                              │                          │                     │
                              │                          │              Create · Save · Dismiss
                    every candidate carries        below it, the             │
                    a reason code and refs         candidate is kept    only Create generates,
                                                   as NOT_WORTH_AN_     and it generates from
                                                   EPISODE, not dropped  the stored proposal
```

Four rules, each requiring a *cluster* rather than an event:

- `WORKSTREAM_COMPLETED` — a finished workstream with decisions and merges behind it.
- `PR_NARRATIVE` — several merged pull requests serving one live workstream.
- `DECISION_CLUSTER` — accepted decisions whose reasoning a digest cannot carry.
- `OPEN_TRADEOFF` — unanswered decisions, scored below the settled stories.

## Decisions Made

- **Suggestions are computed, decisions are stored.** The engine is deterministic over current
  state and its ids are content hashes, so a proposal can always be recomputed. Only what the
  owner said about one is durable. Storing the proposals as well would mean a second copy of
  derived state going stale beside the first, for nothing.
- **The stored decision keeps the proposal verbatim.** When an episode is generated it is built
  from the title, `whyNow` and refs the owner accepted — not from a recomputed topic that has
  since drifted while keeping the same id. This is the idea note's requirement that approval
  preserve exactly what was approved, made structural rather than hoped for.
- **No rule may fire on a single pull request.** Every rule needs a cluster. "Avoid suggesting an
  episode for every PR or normal maintenance change" is the note's central editorial instruction,
  and a rule keyed to one merge cannot honour it.
- **Rejected candidates are recorded, not dropped.** A candidate below the bar is kept as
  `NOT_WORTH_AN_EPISODE` with its reasoning, exactly as the attention engine keeps
  `AUTONOMOUS_PROGRESS`. An editorial judgment nobody can inspect is one nobody can argue with.
- **The editorial judgment is `INFERENCE`.** The engine's opinion that something deserves an
  episode carries this codebase's weakest precedence; the artifacts it read keep their own.
- **Generation is reachable only by POST.** No amount of rendering, prefetching or link-following
  can approve a topic on the owner's behalf.
- **`EPISODE_CREATED` is terminal.** A podcast that was made cannot be un-made, so no later
  decision overwrites the record of it.

## Open Decisions

- **D1. The score bar and the cap.** Shipped at 30 and three open suggestions, with the cluster
  bars at three pull requests and two decisions. Nothing has calibrated these against real use,
  and — as with WS-005's staleness thresholds — the entire value rests on the page staying quiet
  when it should. This is what the next step exists to answer and it cannot be answered from a
  fixture.
- **D2. Whether a topic should expire.** The note raises it. A suggestion currently persists as
  long as the situation that produced it does, which may be right or may mean stale proposals
  linger past their moment.
- **D3. Cross-project topics.** Every rule is project-local today. The note lists "a cross-project
  pattern emerges" as a signal, and nothing here detects one.

## Assumptions

- The owner would rather be shown three proposals they might refuse than ten they must sift. If
  that proves wrong, the cap is the first thing to move.

## Non-Goals

- No automatic generation, on any signal, at any score. Ever.
- No scheduling and no notifications: this is a page the owner visits, not a thing that arrives.
- No change to the digest podcast, the feed, or attention ranking.
- No TTS. Still WS-006's non-goal, and still waiting on the same thing.

## Build Card

- `src/domain/podcast-suggestion.ts` — `TopicSuggestion`, reason codes, scopes, thresholds,
  `StoredSuggestionDecision`.
- `src/podcast/suggest.ts` — the rules, the content-hashed id, `suggestTopics`,
  `openSuggestions`.
- `src/store/schema.ts` v5 + `CompanionStore.decideSuggestion` / `undecideSuggestion` /
  `suggestionDecisions`.
- `CompanionApp.podcastSuggestions()` / `.topicCandidates()` / `.decideSuggestion()` /
  `.undecideSuggestion()` / `.createPodcastFromSuggestion()`.
- `GET /podcast/suggestions`, `POST /podcast/suggestions/:id/{create,save,dismiss,restore}`.

## Implementation State

Built. `tests/podcast-suggestions.test.ts` is organised as the attention suite is — what must
*not* be suggested, what must be, and explainability — because the silence is the feature. It
asserts that a lone merged pull request proposes nothing, that routine progress below the
narrative bar is recorded as considered-and-rejected with its reason, that an abandoned
workstream produces nothing at all, and that the cap holds however much has happened. The
lifecycle cases assert their own precondition rather than skipping when the fixtures are thin, so
they cannot quietly certify a lifecycle they never ran.

The v4 → v5 migration was exercised against a database that already held rows, not only against
a fresh one.

## Review State

Not reviewed. Under `solo` mode this will be an `Owner-accepted` record at merge if the owner
accepts it, written by them or relayed from a decision they actually gave.

## Related Decisions

None yet. D1's answer will deserve one.

## Related PRs

- [#19](https://github.com/50thycal/build-os-companion/pull/19) — the rules, the decision lifecycle, and the approval path

## Next Step

Owner uses the page against real work and rules on D1: does it propose things genuinely worth
understanding, and does it stay quiet otherwise? The failure mode to watch for is not a missing
suggestion but a plausible-looking one that would have wasted an episode.
