/**
 * Source fingerprints - the idempotency key of the whole system.
 *
 * The same source facts observed twice must produce the same fingerprint, so a poll that
 * re-reads an unchanged PR appends nothing. This is the most visible correctness property in
 * the product: get it wrong and the owner sees the same card twice, then stops trusting the feed.
 */

import { createHash } from "node:crypto";
import type { EventType, FingerprintPart } from "../domain/events.ts";
import type { SourceType } from "../domain/provenance.ts";

export interface FingerprintInput {
  projectId: string;
  eventType: EventType;
  sourceType: SourceType;
  sourceId: string;
  parts: FingerprintPart[];
}

/**
 * Field separator: ASCII unit separator, chosen because it cannot occur in the values being
 * joined. Without a separator, `["ab", "c"]` and `["a", "bc"]` hash identically.
 */
const SEP = "\u001f";

/**
 * Absent and null collapse to the same token on purpose: a field that is missing and a field
 * that is explicitly null describe the same state of the world, and source systems are
 * inconsistent about which they send.
 */
function normalizePart(part: FingerprintPart): string {
  if (part === undefined || part === null) return "\u0000";
  if (typeof part === "string") return part.trim();
  return String(part);
}

export function fingerprint(input: FingerprintInput): string {
  const canonical = [
    input.projectId,
    input.eventType,
    input.sourceType,
    input.sourceId,
    ...input.parts.map(normalizePart),
  ].join(SEP);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Event ids derive from the fingerprint, so re-ingestion is idempotent by construction. */
export function eventIdFromFingerprint(fp: string): string {
  return `evt_${fp.slice(0, 24)}`;
}
