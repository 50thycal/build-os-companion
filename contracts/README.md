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
| `npm test` (`tests/contract-sync.test.ts`) | Every test run, offline | The vendored file still matches the `sha256` recorded in `MANIFEST.json`, and the copy consumed by `src/` is byte-identical to the copy here. Catches local edits. |
| `npm run contracts:check` | CI and on demand, needs network | The recorded `sha256` still matches the file at `canonicalPath` in `50thycal/build-os`. Catches upstream drift. |

The offline check is the one that gates the build, because a build must not fail when GitHub is
unreachable. The network check is the one that tells you the protocol moved.

## Updating a vendored contract

1. Land the change in `50thycal/build-os`.
2. `npm run contracts:sync` — pulls the canonical file, rewrites `sha256`, updates the copy
   under `src/`.
3. Review the diff. A contract change is a protocol change; treat it as one.
4. Bump `buildOsVersion` if the protocol version moved, and record the decision.
