/**
 * Verify vendored Build OS contracts against the canonical repository.
 *
 * Needs network. Run in CI and on demand — never from the unit tests, because a build must not
 * fail when GitHub is unreachable. Pass `--sync` to rewrite the vendored copies and hashes.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "contracts", "MANIFEST.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const sync = process.argv.includes("--sync");

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

async function fetchCanonical(path, ref) {
  const url = `https://api.github.com/repos/${manifest.canonicalRepository}/contents/${path}?ref=${ref}`;
  const headers = {
    Accept: "application/vnd.github.raw+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "build-os-companion-contract-check",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(
      `GET ${path}@${ref} from ${manifest.canonicalRepository}: ${response.status} ${response.statusText}`,
    );
  }
  return await response.text();
}

let drifted = 0;

for (const contract of manifest.contracts) {
  const localPath = join(root, "contracts", contract.file);
  const local = readFileSync(localPath, "utf8");
  // An entry may pin its own ref while the canonical change is still in review upstream. That
  // keeps the check meaningful — it still verifies against a real canonical source — instead of
  // either failing for a whole release cycle or being switched off.
  const ref = contract.canonicalRef ?? manifest.canonicalRef;
  const pinned = ref !== manifest.canonicalRef;
  const canonical = await fetchCanonical(contract.canonicalPath, ref);

  if (sha256(canonical) === sha256(local)) {
    console.log(`ok       ${contract.file} matches ${manifest.canonicalRepository}/${contract.canonicalPath}@${ref}`);
    if (pinned) {
      console.log(`         (pinned to ${ref}, not ${manifest.canonicalRef} — return it once that lands)`);
    }
    if (sha256(local) !== contract.sha256) {
      console.log(`         (manifest hash was stale; ${sync ? "updated" : "run with --sync"})`);
      if (sync) contract.sha256 = sha256(local);
      else drifted += 1;
    }
    continue;
  }

  drifted += 1;
  if (!sync) {
    console.error(`DRIFT    ${contract.file} differs from canonical ${manifest.canonicalRepository}/${contract.canonicalPath}@${ref}`);
    console.error(`         local     sha256 ${sha256(local)}`);
    console.error(`         canonical sha256 ${sha256(canonical)}`);
    console.error(`         Resolve upstream first, then: npm run contracts:sync`);
    continue;
  }

  writeFileSync(localPath, canonical);
  if (contract.consumedBy) writeFileSync(join(root, contract.consumedBy), canonical);
  contract.sha256 = sha256(canonical);
  console.log(`synced   ${contract.file} <- ${manifest.canonicalRepository}/${contract.canonicalPath}@${ref}`);
}

if (sync) {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\nManifest updated. Review the diff: a contract change is a protocol change.`);
  process.exit(0);
}

if (drifted > 0) {
  console.error(`\n${drifted} contract(s) out of sync with ${manifest.canonicalRepository}.`);
  process.exit(1);
}
const pinnedEntries = manifest.contracts.filter((c) => c.canonicalRef);
console.log(`\nAll ${manifest.contracts.length} contract(s) match ${manifest.canonicalRepository}.`);
for (const entry of pinnedEntries) {
  console.log(`Note: ${entry.file} is pinned to ${entry.canonicalRef}, not ${manifest.canonicalRef}.`);
}
