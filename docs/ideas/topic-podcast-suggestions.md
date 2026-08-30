# Idea: Topic-Specific Podcast Suggestions

## Status

Idea capture only. Do **not** implement automatic podcast generation from this document.

## Problem

The Companion already helps summarize projects through feeds, podcasts, and subscriptions, but some of the most useful material does not fit a routine chronological update.

A major architectural change, a newly understood subsystem, a postmortem, or a cluster of related decisions can deserve its own focused explanation. A good example is the Kalshi bot's Ops channel: understanding what it is, how it evolved, the bugs found through dogfooding, its authority boundaries, and the next improvements is more useful as a focused explainer than as one item buried in a general project recap.

## Proposed concept

Add a **podcast topic suggestion** layer to Companion.

The system should detect noteworthy topics across the Build OS project feed and surface short proposals for standalone podcast episodes. It should **not automatically generate the episode**. The user sees the suggestion first and explicitly approves a topic before generation begins.

Think of this as an editorial recommendation system rather than another scheduled digest.

## Example suggestion

**Suggested episode:** How the Kalshi Ops Channel Became an AI Control Plane

Why now:

- the channel evolved from simple Railway log/DB access into typed Experiment OS and production operations;
- several real bugs were found and fixed through use, including stale runner code and concurrent-result loss;
- new improvements are being proposed around health checks, capability discovery, mutation verification, incident bundles, and auditability;
- understanding the architecture helps the owner operate and extend the system safely.

Possible outline:

1. Why Ops exists.
2. How a request travels from Claude/ChatGPT through GitHub Actions into production.
3. Read capabilities versus bounded write authority.
4. What dogfooding exposed and how the design changed.
5. Why typed operations are safer than broad shell/Railway access.
6. What Ops vNext could become.

Action presented to user: **Create podcast** / **Dismiss** / optionally **Save for later**.

## What should trigger a topic suggestion

Candidate signals include:

- a substantial new feature or subsystem lands;
- a workstream closes with an important architecture/result story;
- multiple related PRs form a coherent narrative;
- a major operational incident or postmortem produces durable lessons;
- a project changes direction or reaches a meaningful decision point;
- a technical system becomes important enough that the owner would benefit from a conceptual explainer;
- an experiment produces a significant finding that deserves more depth than a feed card;
- a cross-project pattern emerges;
- the owner asks a detailed question whose answer naturally becomes a reusable explainer.

Avoid suggesting an episode for every PR or normal maintenance change. The value is editorial selectivity.

## Suggested card shape

A topic proposal in the Companion feed could contain:

- **Episode title** — concise, human-oriented rather than a PR headline;
- **Why this is worth an episode** — 1–3 sentences;
- **Source projects/workstreams** — provenance links;
- **What you would learn** — a few conceptual beats;
- **Freshness/relevance** — why it is timely now;
- **estimated scope** — short explainer / normal episode / deep dive if useful;
- user actions: **Create podcast**, **Save**, **Dismiss**.

The card should not contain a generated script/audio yet.

## Approval boundary

The core rule:

> Suggest freely; generate only after explicit user approval.

A suggestion may be generated automatically as part of feed processing, but no LLM-heavy podcast script/audio job should start merely because a topic scored highly.

Approval should preserve the exact topic proposal/provenance so the eventual generator knows what the user approved.

## Editorial model

Topic selection should favor **understanding over activity volume**.

Useful ranking dimensions could eventually include:

- architectural significance;
- amount of related change across recent commits/PRs/workstreams;
- user impact;
- novelty versus previous podcasts;
- presence of a clear story arc (problem → discovery → decision → outcome);
- unresolved tradeoffs worth explaining;
- cross-project relevance;
- likely value to the owner's mental model of the system.

A large code diff is not automatically a good episode. A small change that resolves a subtle operational failure can be.

## Relationship to existing podcasts

This should complement, not replace:

- scheduled project/news digests;
- general Build OS recap podcasts;
- subscriptions to projects/workstreams.

Potential distinction:

- **Digest podcast:** “What changed?”
- **Topic podcast:** “Help me understand this.”

That separation is the main product idea.

## Future implementation questions

When this is eventually scheduled for implementation, decide:

1. Where topic candidates are generated: ingestion, feed synthesis, or a dedicated editorial pass.
2. Whether suggestions are project-local or can combine multiple repositories.
3. How previous generated/dismissed topics suppress duplicates.
4. How an approved suggestion becomes an existing podcast-generation job.
5. Whether the user can manually request `Suggest a podcast about this` from any feed item/workstream.
6. How source provenance is carried into the final script so the episode remains grounded.
7. Whether suggestions expire when a topic becomes stale.

## Non-goals for this idea capture

- Do not automatically generate audio.
- Do not add a scheduler.
- Do not change current feed ranking.
- Do not implement UI from this note alone.
- Do not create a new podcast pipeline if the existing generator can accept an approved topic later.

The next step, if prioritized, should be a small product/design pass against the current Companion feed and podcast architecture before implementation.
