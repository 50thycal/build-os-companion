# Architecture

One normalized layer, several renderers. Everything here exists to make that true rather than
aspirational.

```text
GitHub          Build OS artifacts        agent checkpoints
   │                    │                        │
   └────────────────────┴────────────────────────┘
                        │  normalizers
                        ▼
             append-only event ledger          idempotent, provenanced, durable
                        │
        ┌───────────────┼────────────────┐
        ▼               ▼                ▼
  state projection  artifact snapshots  attention lifecycle
   PRs from events   latest reading of   one row per situation,
                     canonical files     first-seen and cleared
        └───────────────┼────────────────┘
                        ▼
                    CompanionApp                 the one read model
                        │
        ┌───────────────┼────────────────┬───────────────┐
        ▼               ▼                ▼               ▼
      feed          needs me          project        fact pack ──► podcast (later)
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

#### Which layer owns which field

Precedence is a tiebreak, and a tiebreak is the wrong tool when two sources are not answering the
same question. Each field has an **owner**, and the other layers do not get a vote on it:

| Field | Owned by | Because |
|---|---|---|
| Workstream phase, status, goal, next step, open decisions | The durable Build OS artifact | GitHub cannot promote a workstream. The Companion must never write a phase the owner did not. |
| Pull request lifecycle, merge time, CI, review, mergeability | GitHub | The artifact's prose about a pull request is a claim; GitHub is the fact. |
| Whether a project is followed | The discovery rule, plus the owner's pins | See `src/ingest/github/discovery.ts`. |

**Disagreement between owners is a third output, never a tiebreak.** A workstream recorded
`READY_TO_BUILD / BLOCKED` while its implementation pull request is already merged produces an
integrity finding saying exactly that. It does not become `COMPLETE`, and the blocker sentence is
not deleted to make the card agree with itself. Silently picking a winner destroys the evidence
that something went wrong, which is the one thing this application is for.

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

**A dismissal is the owner's fact, not the engine's.** `dismissedAt` (`src/store/store.ts`) records
"I've seen this" and is filtered out of `openAttention()` and the badge count by default — but it
is never `clearedAt`, which stays exclusively the engine's own determination that a rule stopped
matching. Overloading one field with both meanings would let a dismissal read back later as
resolution, which is exactly the kind of quiet rewrite the rest of this application refuses to do.
A dismissal is not forever, either: it resurfaces on its own the moment the same item gets *worse*
(a severity increase is information the owner was not actually told), and a fresh occurrence after
a real resolution always starts undismissed. `Needs Me` still shows dismissed-but-open items behind
a disclosure, honestly labeled as still true — nothing here pretends an open situation went away.

### Feed — `src/feed/`

A card answers five questions: what changed, why it matters, where it is now, is anything blocked,
what happens next. `needsYou` is always populated — `Nothing.` is an answer the owner needs.

Cards **collapse** many events about one entity into one, which is what turns "7 commits + 3 CI
reruns + a description edit" into "PR #84 moved into review; CI is now green", and what lets the
feed survive the owner being away for a week. Every card keeps the ids of the events it collapsed.

The headline is the most significant event, and the most recent *within* that significance band.
Collapsed events become a subordinate **trail** in the order they happened — `Opened 7 h ago;
merged 17 min ago.` — rather than being concatenated onto the headline, which produced `PR #146
merged. Also: PR #146 opened.`: lossless and useless.

`currentState` is **lifecycle-aware**, and this is where the sharpest dogfood defect was. A merged
pull request said `checks green, no review yet` — two true historical facts assembled into a false
sentence, because "no review yet" claims review is still to come. The conclusion now leads and the
pre-merge facts follow it in the past tense. Nothing is discarded: that a merged PR carried no
review is precisely what the merge gate cares about.

A card also carries `contradictions`, the integrity findings about that entity, so a disagreement
between the durable record and GitHub appears on the thing it concerns rather than on a
project-level list the owner has to go and find.

**Ranking is pure chronology** — newest first, ties broken by id. It used to blend severity into
the score heavily enough that a HIGH card from days ago sat permanently above anything that
happened since: a week-old blocked workstream pinned above this morning's merge, every time the
Feed was opened. That blend belongs to `Needs Me`, which already exists to answer "what needs me";
the Feed answers a different question, "what's new," and severity is shown on a card — the badge,
the `contradictions` row — never used to reorder it.

Cards from every followed project interleave in that one chronological stream rather than being
grouped by project — grouping was tried and reverted after real use read worse than a flat list
with each card tagged by its project, and the app already has a project-first `/projects` view for
that question.

Card content is **data**. Rendering belongs to whatever consumes it.

### Discovery — `src/ingest/github/discovery.ts`

Which repositories the Companion follows is a **rule**, not a list. It was a list — two names in
`companion.config.json`, with everything else disabled — and the owner's portfolio was whatever
they had last remembered to type.

A repository is eligible when it was pushed inside a rolling window (60 days by default) *and*
activity in that window can be attributed to the owner:

1. owner-authored commits;
2. owner-authored or updated pull requests;
3. neither — `pushed_at` alone, which is a fallback rather than a signal of ownership, and is
   never enough for a fork (an upstream sync moves it) or an archived repository.

Private repositories are included wherever the token can read them. Listing paginates to the end
of the window; there is no cap on how many projects a portfolio may have. `companion.config.json`
keeps the two things a rule cannot know — a **pin**, followed whatever its activity says, and a
**path override** — and an empty `projects` list is a working configuration.

A repository that falls out of the window is **disabled, never deleted**: its rows and its history
stay. Ageing out happens only on a cycle where discovery actually answered, so a failed listing
never empties the feed.

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

---

## Persistence — `src/store/`

SQLite through `node:sqlite`: no dependency, no server, one file to back up. For a single-owner
application that is the right amount of database, and because `node:sqlite` is synchronous the
durable ledger implements the same `EventLedger` interface as the in-memory one — the
projection, attention and feed layers are untouched by persistence existing.

Four kinds of thing are stored, and keeping them apart is what makes "what changed since I last
checked" answerable.

**Events** are append-only, and ordered by an insertion sequence rather than by when they
happened. That distinction is load-bearing. A pull request opened in January and first observed
today is new to the owner even though its timestamp is eight months old; an `occurred_at` window
misses it silently. The read cursor is therefore a sequence number, and `afterSequence` — not
`since` — is what the briefing reads.

**Artifact snapshots** are the latest reading of each project's canonical files. The ledger
cannot stand in for them: workstream events are only emitted when the normalizer sees a change it
watches, so a workstream that gains an open decision without changing phase produces no event at
all, and the newest snapshot in the ledger would still show the old count. Storing the reading is
what makes the Project screen correct after a restart with no sync.

**Attention lifecycle** is one row per situation, carrying when it first appeared and when it
stopped being true. Item ids are already deterministic — same situation, same id — which makes
this a lifecycle rather than a replace: an item that persists keeps its original first-seen time,
so "waiting on you since Tuesday" stays true, and one that stops being produced is marked
resolved rather than deleted, because "resolved since you last checked" is something the owner
needs told and a deleted row cannot tell them.

Attention is compared against *when the owner last checked*, not against the event sequence. An
item can open with no event behind it — a pull request goes stale because a threshold passed
while nothing happened — and a `sequence >` comparison drops exactly those, the ones that arrived
silently.

**Cursors**: per-repository sync progress, and the owner's read position. Re-reading the config
file never resets sync progress, and the read cursor never moves backwards.

A failed poll never overwrites good state. The project is marked stale, the last picture that was
true stays, and one project failing does not stop the others.

---

## The read model — `src/app/`

Every screen goes through `CompanionApp`, and `CompanionApp` goes through the store and the
ledger. This is the rule the design depends on: a screen never reaches past it to GitHub, so
there is exactly one interpretation of what is true. `tests/web.test.ts` serves every page with
a GitHub client that throws if anything touches it, which turns the rule from a convention into
something that breaks the build.

Attention is read from storage rather than recomputed per request. The engine produced those
items at sync time and their lifecycle is what the briefing reads; recomputing here would let
the Needs Me screen and the briefing drift apart within one page load.

---

## Briefing — `src/briefing/`

Two layers over the same state.

`since.ts` groups changes by what they mean — now needs you, stopped needing you, finished,
broke, moved forward, happened without you — and collapses them per entity. One entity lands in
exactly one section: a pull request whose CI failed and then merged is reported as finished, not
in both places. This is not a chronological dump, because "what happened in what order" is a
different question from "what did being away cost me".

`fact-pack.ts` builds the six-section briefing structure over the same canonical state. Every
fact carries `refs` back to the events and entities that produced it, and a test resolves every
event reference against the ledger. That is the property the whole thing exists for: this
structure is meant to be rendered into prose later, and the contract that renderer inherits is
that it restates the supplied pack and nothing else — no querying the ledger, no calling GitHub,
nothing asserted that no `FactRef` accounts for. A fact nobody can check is worse than no fact in
a briefing meant to be acted on.

The first renderer is deterministic, and is arguably the right permanent one.

---

## Web — `src/web/`

Node's own `http`, server-rendered HTML, one stylesheet, no framework and no build step. It
loads on one bar of signal, there is nothing to rebuild, and there is no second copy of the
interpretation logic living in a browser.

Built for a phone: navigation at the bottom in thumb reach, tap targets given a 44px hit box
through padding with an equal negative margin so the touch area grows and the layout does not,
and `safe-area-inset` respected top and bottom. `npm run check:mobile` loads every page at an
iPhone viewport and fails on horizontal overflow or small tap targets.

The read cursor moves on exactly one thing: a POST from the button on the briefing page.
Rendering does not move it, syncing does not move it, and a malformed submission does not. Each
of those has a test, because a cursor that advanced when a background process drew a screen would
quietly consume the one piece of state the owner is relying on.
