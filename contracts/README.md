# Vendored Build OS contracts

`50thycal/build-os` is the **canonical** source of every protocol contract in this directory.
Nothing here may be edited to change protocol meaning. If a contract needs to change, the
change is made in `build-os` first and vendored down afterwards.

## Why vendor at all

The Companion has to parse checkpoints and Build OS artifacts without a network round-trip to
the protocol repository, and its tests have to run offline and deterministically. So the
contracts are copied in — and because the cost of a copy is drift, the copy is **checked**
rather than trusted.

## The two checks

| Check | When | What it proves |
|---|---|---|
| `npm test` (`tests/contract-sync.test.ts`) | Every test run, offline | The vendored file still matches the `sha256` recorded in `MANIFEST.json`, and — where an entry names a `consumedBy` copy under `src/` — that copy is byte-identical to the one here. Catches local edits. |
| `npm run contracts:check` | CI and on demand, needs network | The recorded `sha256` still matches the file at `canonicalPath` in `50thycal/build-os`. Catches upstream drift. |

The offline check is the one that gates the build, because a build must not fail when GitHub is
unreachable. The network check is the one that tells you the protocol moved.

## Not every entry is a schema

`WORKSTREAM.template.md` is vendored too. It is not parsed at runtime — it is read by
`tests/review-state-parse.test.ts`, which proves the protocol's own workstream template still
parses under this Companion's rules. Testing against an invented fixture instead would prove
only that the Companion agrees with itself; testing against the real template is what notices
when the protocol changes shape.

Entries like that have a `readBy` rather than a `consumedBy`: there is no second copy under
`src/`, so there is nothing to keep byte-identical, and the offline check verifies the hash
alone.

## Pinning an entry to a ref

A protocol change is made canonical-first, which means there is a window where the canonical
version of a contract exists on a branch rather than on `main`. An entry may pin its own ref for
that window:

```json
{
  "file": "WORKSTREAM.template.md",
  "canonicalRef": "codex/ws-007-feedback-review-closure",
  "$comment": "Return to main and re-sync once build-os#7 merges."
}
```

The check still runs against a real canonical source, so it still catches a local edit or an
upstream change — it is simply looking at the ref where that version actually lives. It is not a
way to exempt a file: an entry with no `canonicalRef` uses the manifest's, and both `check` and
`sync` print the pinned ref every run so the window cannot be forgotten quietly.

No entry is pinned right now. `WORKSTREAM.template.md` was, to the branch of `build-os` PR #7
while v0.5 was in review; that PR merged on 2026-08-24 and the pin came off — the vendored copy
was already byte-identical to what landed on `main`.

## Updating a vendored contract

1. Land the change in `50thycal/build-os`.
2. `npm run contracts:sync` — pulls the canonical file, rewrites `sha256`, updates the copy
   under `src/`.
3. Review the diff. A contract change is a protocol change; treat it as one.
4. Bump `buildOsVersion` if the protocol version moved, and record the decision.
