# WS-006 — Podcast renderer

**Phase:** BUILDING · **Status:** Active
**Created:** 2026-08-23 · **Updated:** 2026-09-02

## Goal

Two script types, both grounded in the fact pack:

- **Digest** — what changed, read straight from the fact pack the briefing page already renders.
- **Deep dive** — help me understand this, built from a topic and the specific facts the owner
  has approved for it (`docs/ideas/topic-podcast-suggestions.md`).

Text scripts only for now — see *Non-Goals*. Audio, when it exists, renders these scripts rather
than deciding anything on its own.

## Context

The point of the shared event/state layer is that the podcast is a renderer, not a second
product. It exists in the plan from the start so the architecture is built to support it; it is
deliberately last so it cannot be built on unvalidated state.

## Current Mental Model

```text
events + state ──► fact pack ──► written briefing ──► outline ──► script ──► TTS
                       ▲              ▲
                       │              │
              every spoken claim   the debugging layer:
              traces to a fact     if the text is wrong,
                                   the audio is wrong
```

Two roles, each doing real work:

- **Reporter** — what happened, factual state, chronological transitions.
- **Analyst** — implications, cross-project connections, risks, blockers, what needs the owner.

The final segment of every briefing answers one question: what needs me next?

## Decisions Made

- **The written briefing is a required intermediate.** Not an optimization — it is where factual
  errors are caught before they are spoken.
- **Every factual statement is grounded in the fact pack.** No host may assert anything absent
  from it.
- **Script generation is deterministic and template-based, not model-generated.** The same
  discipline `briefing/render.ts` documents for prose: a line may only restate a `Fact`'s own
  fields. The Analyst's synthesis lines are derived from structured fields already on the fact
  (severity, action, counts) — real work, but never a new claim. This can be revisited once
  script *rendering* has been listened to and text-first proves too flat, but it is not
  assumed to need revisiting yet.
- **This build stops at the script.** TTS, voice, and delivery stay open — see *Non-Goals* —
  because settling them well needs scripts to react to, not the reverse.
- **Deep-dive topic *selection* stays out of this workstream.** A deep dive here is only ever
  built from a topic and a set of facts the owner has already chosen (currently: ticking facts
  on a form). Deciding what deserves a deep dive automatically is
  `docs/ideas/topic-podcast-suggestions.md`'s Suggest/Save/Dismiss idea, not yet built.

## Open Decisions

- TTS provider, voice selection, and delivery (private RSS versus in-app) are all still open,
  and still deliberately unsettled — see *Non-Goals*.
- Whether the two-host format holds up once the owner has actually read (or eventually heard) a
  handful of scripts, or whether a single narrator plus a clear "what needs me" close serves
  better. Real use is what would answer that, not a hypothetical.

## Assumptions

- Two hosts make a briefing more informative rather than merely longer. If that proves false in
  listening tests, one narrator plus a clear attention section is the fallback.

## Non-Goals

- No TTS work, no audio pipeline, no provider selection in this pass.
- No automatic deep-dive topic detection/suggestion — that is idea-only
  (`docs/ideas/topic-podcast-suggestions.md`) and a separate build.
- No persistence of generated scripts. A deep-dive script exists for the response that generated
  it; nothing is saved, scheduled, or fed back into the feed yet.

## Build Card

- `src/podcast/types.ts` — `PodcastScript`, `PodcastSegment`, `PodcastLine`, `DeepDiveBeat`,
  `DeepDiveTopic`.
- `src/podcast/digest.ts` — `buildDigestPodcastScript(pack)`, straight off `FactPack`.
- `src/podcast/deep-dive.ts` — `buildDeepDivePodcastScript(input)`, off an owner-approved topic
  and beats.
- `src/podcast/render.ts` — `renderPodcastScript(script)`, the plain-text transcript; mirrors
  `briefing/render.ts`'s contract (renders the script and nothing else).
- `CompanionApp.digestPodcastScript()` / `.deepDivePodcastScript({ topic, factIds })` — the read
  model every route goes through, same as `.briefing()`.
- Routes: `GET /podcast` (digest), `GET /podcast.txt`, `GET /podcast/deep-dive` (pick a topic and
  facts from the current pack), `POST /podcast/deep-dive` (generate, render inline — not saved).
- Linked from the briefing page ("Hear it as a podcast script").

## Implementation State

Built. `tests/podcast.test.ts` checks the grounding property directly: every Reporter line
outside the framing segments (cold open/close) carries at least one `FactRef`, `sourceFactIds`
never names a fact absent from the source pack, and rendering is deterministic. `CompanionApp`
tests confirm the digest script comes from the same fact pack the briefing page renders, and that
a deep dive with unknown fact ids produces an honest empty script rather than inventing content.
`scripts/check-mobile.mjs` now also walks `/podcast` and `/podcast/deep-dive`.

## Review State

Not yet reviewed under `solo` mode — see `CLAUDE.md`. This will be an `Owner-accepted` record at
merge, not a self-written one.

## Related Decisions

None yet.

## Related PRs

Opened from this build; filled in once the PR number is known.

## Next Step

Owner review of the two script types against real use — do the scripts read as something worth
listening to, does the Analyst's synthesis actually add anything, does two-host still make sense
once there is text to react to rather than a diagram.

## Unblocked

**Was:** Blocked until WS-005 produced a validated fact pack and written briefing.

**Unblocked 2026-09-02.** The owner confirmed directly in this conversation — relayed here per
`CLAUDE.md`'s `solo`-mode rule on relaying an acceptance the owner actually gave, naming the
channel — that the Needs Me screen and the fact pack/written briefing have held up against real
use, which is what this workstream's blocker was waiting on. That is a real-use judgment on
WS-005, not a code-review verdict on a PR; WS-005 itself stays in `REVIEW` on the control board,
since its own open decision (D1, staleness thresholds) is unrelated and still open. The
scope this unblocks was also decided in that conversation: scripts only, TTS deferred — recorded
above under *Non-Goals*.
