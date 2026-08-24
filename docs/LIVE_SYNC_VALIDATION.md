# Live sync validation — 2026-08-24

Phase 2 of the Companion build: run the ingestion path against real repositories and fix what
real payloads disprove. Before this, every assertion about GitHub and about Build OS artifacts
was made against fixtures somebody wrote by hand. 120 tests passed and seven assumptions were
wrong.

Repositories: `50thycal/party-games` and `50thycal/build-os`.

---

## What was exercised, and what was not

Being precise about this matters, because "live ingestion is proven" is a claim the rest of the
build rests on.

| Layer | Exercised against | How |
|---|---|---|
| Build OS artifact parsing | **Real files** | The actual `ACTIVE.md`, workstream files and decision logs of both repositories, read from clones |
| Build OS path detection | **Real repository layouts** | `git ls-files` output from both repositories |
| PR / lifecycle / timestamp / base-head mapping | **Real payloads** | Responses recorded from the GitHub API for party-games PRs #133–#142 |
| Mergeability | **Real payloads** | Observed `mergeable_state` on live open and merged PRs |
| CI / check state | **Real payloads** | Observed check-run and workflow responses for both repositories |
| Bot / agent detection | **Real payloads** | Observed author accounts and branch names on all recorded PRs |
| Workstream ↔ PR relationships | **Real files + real payloads** | Real board rows resolved against real PR numbers |
| Full pipeline (normalize → ledger → projection → attention → feed) | **Real data** | `tests/live-sync-integration.test.ts`, through the real `GitHubPort` interface |
| `HttpGitHubClient`'s own HTTP transport | **Recorded payloads, not a live socket** | See below |

**The one gap.** The environment this validation ran in routes outbound traffic through a proxy
whose egress policy permits `api.github.com/user` but refuses `/repos/*`. Repository data was
therefore obtained through an authorized GitHub tool rather than by the client's own `fetch`.
Every recorded payload is real; the request-building and response-parsing code in
`HttpGitHubClient` is exercised against those payloads via an injected `fetch`, so URL
construction, pagination arguments, retry behaviour and error mapping are all covered — but the
socket itself was not opened from this environment. The first run against an unrestricted
network should be treated as confirming the transport, not the mapping.

Review state is the one item on the Phase 2 list with **no real data behind it**: neither
repository has a single submitted GitHub review. Both use agent review through PR comments. So
`deriveReviewState` remains covered only by constructed cases, and is called out here rather
than counted as proven.

---

## What real data disproved

### 1. Bullets were read to the end of the line, not the end of the item

Every bundled fixture wrote list items on one line. Real Build OS artifacts hard-wrap at ~100
columns, so `listItems` returned the first physical line of each entry and silently dropped the
rest. WS-001's first open decision came out as:

> Shelving. A company may leave a contract off the schedule entirely and eat its

The damage is not that it is short. It is that it reads like a complete sentence, so nothing
downstream can tell it was cut — and the attention engine quotes this string verbatim onto the
Needs Me screen. All eight of WS-001's decisions were truncated mid-clause.

Fixed by continuing an item across wrapped lines and ending it at a blank line, a new item, a
heading, or a table — a lazy continuation in the CommonMark sense.

### 2. A decision entry is a paragraph, not a question

Real entries carry the decision, its rationale, the options, and the implementer's
recommendation — 600+ characters. Keeping all of it as `question` makes the attention line
unreadable; cutting it loses what the owner needs in order to decide. `OpenDecision.question` is
now the opening sentences and `OpenDecision.detail` keeps the entry whole.

### 3. Prose sections carried the file's line breaks into the product

`Next Step` rendered with the artifact's wrapping baked in, so a feed card would have shown the
owner where the file's lines happened to end. Collapsed on the way in.

### 4. `merged` is absent from the pull-request *list* payload

The list endpoint returns no `merged` field at all; only the detail endpoint has it. Every
merged PR in party-games carries `merged_at` while any `merged` field reads false. Deriving from
`merged_at` was already correct — but nothing proved it, and reading `pr.merged` would have
reported all nine merged PRs as merely closed. Now locked by a fixture recorded from the real
list response.

### 5. Every open PR answers `mergeable_state: "unknown"` on first read

GitHub computes mergeability asynchronously. PR #142 was open and returned `unknown`; so did
every other PR observed. Left alone this is not a cosmetic gap: `MERGE_CONFLICT` is an attention
rule, and permanently-unknown mergeability means that rule can never fire, so a conflicted PR
would sit on the feed looking fine. Open PRs are now re-read until it resolves. Closed and
merged PRs are not, because GitHub stops computing it for them and the answer never arrives.

### 6. Neither followed repository runs any CI

party-games has zero workflows and zero check runs; build-os has no `.github` directory at all.
`CiState` is `NONE` for every real pull request — and the quiet-state sentence rendered that as:

> PR #142 is healthy: none CI, review none.

Ungrammatical, and worse, it turns an absence of evidence into a claim of health. Phrasing is
now shared across the feed, the attention engine and the briefing, and says "no checks
reported". Separately, the client now reads commit statuses alongside check runs, so a
repository whose CI is entirely Vercel-style statuses is not mistaken for one with no CI.

### 7. The two repositories lay their artifacts out differently

party-games keeps `docs/DECISIONS.md`. build-os keeps `DECISIONS.md` at the repository root and
has no project model at all. Resolving to the convention regardless made build-os report zero
decisions — not an error, just a quietly empty section, which is the worst way for this to fail.
Detection now probes candidate locations against the paths the repository actually has, with
explicit overrides still winning. Both repositories resolve correctly with no configuration.

### 8. Agents push under the owner's own account

Every agent PR in party-games is authored by `50thycal` with `user.type: "User"`, on branches
like `codex/ws-002-noop-undo-fix` and `claude/adopt-build-os-framework-s5w8xb`. Bot detection by
account type reported all of it as work the owner typed. Authorship now also reads the branch
prefix and credits those events to an `AGENT` actor — which is what lets the feed distinguish
"you did this" from "this happened while you were away".

---

## Regression coverage added

| File | Covers |
|---|---|
| `tests/buildos-live-regression.test.ts` | Findings 1, 2, 3, 7 — against the real artifacts |
| `tests/github-live-regression.test.ts` | Findings 4, 5, 6, 8 — against the recorded real payloads |
| `tests/live-sync-integration.test.ts` | The whole pipeline over real data; repeated sync; sync failure |
| `fixtures/github/live/`, `fixtures/build-os/live/` | The recorded payloads and artifacts themselves |

161 tests, up from 120.

---

## Still unproven

- **Review state.** No real reviews exist in either repository.
- **The HTTP transport itself**, for the reason described above.
- **Pagination.** party-games has 10 pull requests and build-os 6; neither exceeds one page, so
  the `per_page` path has never been made to turn over.
- **Rate limiting.** Never approached at this volume. The client has no 403/429 backoff.
