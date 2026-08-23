# Architecture

One normalized layer, several renderers. Everything here exists to make that true rather than
aspirational.

```text
GitHub          Build OS artifacts        agent checkpoints
   │                    │                        │
   └────────────────────┴────────────────────────┘
                        │  normalizers
                        ▼
             append-only event ledger          idempotent, provenanced
                        │
                        ▼
                 state projection              PRs, workstreams, sessions, decisions
                        │
                        ▼
                 attention engine              deterministic, reason-coded
                        │
        ┌───────────────┼────────────────┐
        ▼               ▼                ▼
      feed          briefing          podcast          (briefing and podcast: later)
```

Nothing downstream of the ledger touches a source system. That single rule is what stops the feed
and a future podcast from disagreeing — the failure the design plan names outright.

---

## Guarantees per layer

### Ledger — `src/ledger/`

**Idempotent.** Every event carries a `source_fingerprint` computed from the source facts that
make an occurrence distinct. Ingesting the same observation twice appends nothing; event ids are
derived from the fingerprint, so identity survives re-ingestion.

The normalizer declares `fingerprintParts` — what makes this occurrence distinct. Too broad and
the feed duplicates; too narrow and real changes vanish. Parts are joined with a unit separator
so `["ab","c"]` and `["a","bc"]` cannot collide.

**Append-only.** Nothing edits an event. State is rebuilt, which is what makes "what changed since
I last checked" answerable and what lets a corrected normalizer fix history.

### Normalization — `src/ingest/`

Events are **owner-meaningful**, not webhook-shaped. Several GitHub deliveries may produce one
event; some produce none.

Polling shows current state, not transitions, so events come in two kinds:

- **Intrinsic** — derivable from immutable facts (a PR's `createdAt`, a review id and submission
  time, a check run id and completion time). Safe on every poll.
- **Transition** — needs the previous projection (`PR_READY_FOR_REVIEW`, `PR_UPDATED`, workstream
  phase changes). Emitted only when a previous state exists.

So a first sync backfills intrinsic history and stays quiet about transitions it never witnessed.
Inventing a "ready for review" moment the Companion did not see would be inference dressed as fact.

### Parsing — `src/ingest/buildos/`

Governed by [`framework/BUILD_OS_PARSE_CONTRACT.md`](../framework/BUILD_OS_PARSE_CONTRACT.md).

**Conservative.** A field that cannot be read confidently is absent, never guessed. An absent phase
is a parser admitting ignorance, which the product can show honestly.

**Disagreement is surfaced, not merged.** When `ACTIVE.md` and a workstream file conflict, the file
wins for detail and the mismatch becomes an integrity warning naming both sources. Warnings are
about the *project's* records, addressed to its owner — they never stop the rest of the parse.

**Many-to-many.** One workstream may span several PRs; one PR may serve several workstreams. The
projection models both; a schema that assumed otherwise would need rebuilding the first time real
Build OS work arrived.

### Precedence — `src/domain/provenance.ts`

```text
canonical Build OS artifact > GitHub PR/CI state > session checkpoint > AI inference
```

`resolveField` applies it and returns conflicts rather than silently choosing. Two readings of the
*same* source are staleness, not conflict — a UI that cries conflict every poll will be ignored.

### Sessions — `src/ingest/checkpoint/`

State, never transcripts. The vendored schema forbids additional properties, so a transcript field
cannot be added by accident, and `tests/contract-sync.test.ts` proves the vendored copy still
matches the canonical one.

**Silence is never success.** A silent `ACTIVE` or `WAITING` session becomes `UNKNOWN`. A silent
`BLOCKED` session is marked stale but stays blocked — silence does not unblock anything, and
demoting it would drop the attention item the owner needs. Nothing here ever produces `COMPLETED`.

### Attention — `src/attention/`

Deterministic. Same state and clock, same items and ids.

Every item carries a reason code, a sentence naming the specific thing, a recommended action, and
the sources it was derived from. There is no opaque urgency score, because a badge the owner
cannot interrogate is one they learn to ignore.

**Suppression is recorded, not implied.** When CI is failing but an agent is on it, the engine
emits an `AUTONOMOUS_PROGRESS` item at severity `NONE` saying so. A `Needs Me` list that fires on
healthy autonomous work is worse than no list, so the reasons for staying quiet are as explicit as
the reasons for speaking up.

`Needs Me` is everything at `MEDIUM` or above.

### Feed — `src/feed/`

A card answers five questions: what changed, why it matters, where it is now, is anything blocked,
what happens next. `needsYou` is always populated — `Nothing.` is an answer the owner needs.

Cards **collapse** many events about one entity into one, which is what turns "7 commits + 3 CI
reruns + a description edit" into "PR #84 moved into review; CI is now green", and what lets the
feed survive the owner being away for a week. Every card keeps the ids of the events it collapsed.

Ranking blends attention severity with recency, so a three-day-old blocking decision outranks a
green CI run from a minute ago.

Card content is **data**. Rendering belongs to whatever consumes it.

---

## Ports, so the deferred choices stay deferred

| Port | Implemented | Deferred |
|---|---|---|
| `EventLedger` | `InMemoryEventLedger` | Postgres |
| `GitHubPort` | `HttpGitHubClient`, fixture double | GitHub App, webhooks |
| Feed output | `FeedCard[]` | Web UI |
| Sessions | in-memory list | checkpoint intake API |

Each is a real interface with at least two implementations in play, which is the only way to know
a seam is honest.

---

## Where the next session picks up

WS-002 needs persistence and a UI; WS-004 needs the checkpoint intake API; WS-005 needs
`Since I last checked` and the written briefing. The layers above do not change to accommodate any
of them — that is the point.
