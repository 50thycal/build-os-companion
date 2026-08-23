import { describe, expect, it } from "vitest";

import { fingerprint, eventIdFromFingerprint } from "../src/ledger/fingerprint.ts";
import { InMemoryEventLedger, materialize } from "../src/ledger/ledger.ts";
import type { EventDraft } from "../src/domain/events.ts";

function draft(overrides: Partial<EventDraft> = {}): EventDraft {
  return {
    projectId: "proj_1",
    eventType: "PR_OPENED",
    source: {
      sourceType: "GITHUB_STATE",
      sourceId: "pr:84",
      sourceUrl: "https://github.com/o/r/pull/84",
      observedAt: "2026-08-23T12:00:00Z",
    },
    actor: { type: "HUMAN", name: "50thycal" },
    occurredAt: "2026-08-21T09:00:00Z",
    pullRequestNumber: 84,
    summaryShort: "PR #84 opened",
    fingerprintParts: [84, "2026-08-21T09:00:00Z"],
    ...overrides,
  };
}

describe("fingerprint", () => {
  it("is stable for identical source facts", () => {
    const input = {
      projectId: "p",
      eventType: "PR_OPENED" as const,
      sourceType: "GITHUB_STATE" as const,
      sourceId: "pr:84",
      parts: [84, "2026-08-21T09:00:00Z"],
    };
    expect(fingerprint(input)).toBe(fingerprint(input));
  });

  it("separates parts, so field boundaries cannot be shifted", () => {
    const base = {
      projectId: "p",
      eventType: "PR_OPENED" as const,
      sourceType: "GITHUB_STATE" as const,
      sourceId: "pr:1",
    };
    expect(fingerprint({ ...base, parts: ["ab", "c"] })).not.toBe(
      fingerprint({ ...base, parts: ["a", "bc"] }),
    );
  });

  it("treats absent and null as the same fact", () => {
    const base = {
      projectId: "p",
      eventType: "CI_PASSED" as const,
      sourceType: "GITHUB_STATE" as const,
      sourceId: "check:1",
    };
    expect(fingerprint({ ...base, parts: [undefined] })).toBe(
      fingerprint({ ...base, parts: [null] }),
    );
  });

  it("changes when a meaningful fact changes", () => {
    const base = {
      projectId: "p",
      eventType: "PR_UPDATED" as const,
      sourceType: "GITHUB_STATE" as const,
      sourceId: "pr:84",
    };
    expect(fingerprint({ ...base, parts: [84, "t1"] })).not.toBe(
      fingerprint({ ...base, parts: [84, "t2"] }),
    );
  });

  it("derives the event id from the fingerprint", () => {
    const fp = fingerprint({
      projectId: "p",
      eventType: "PR_OPENED",
      sourceType: "GITHUB_STATE",
      sourceId: "pr:1",
      parts: [],
    });
    expect(eventIdFromFingerprint(fp)).toBe(`evt_${fp.slice(0, 24)}`);
  });
});

describe("event ledger", () => {
  it("appends new events and rejects duplicates", () => {
    const ledger = new InMemoryEventLedger();

    const first = ledger.append([draft()]);
    expect(first.appended).toHaveLength(1);
    expect(first.duplicates).toBe(0);

    const second = ledger.append([draft()]);
    expect(second.appended).toHaveLength(0);
    expect(second.duplicates).toBe(1);
    expect(ledger.size()).toBe(1);
  });

  it("gives a re-ingested event the same id", () => {
    const a = materialize(draft(), new Date("2026-08-23T12:00:00Z"));
    const b = materialize(draft(), new Date("2026-08-24T18:00:00Z"));
    expect(a.id).toBe(b.id);
    expect(a.sourceFingerprint).toBe(b.sourceFingerprint);
    // Ingestion time differs; identity does not.
    expect(a.ingestedAt).not.toBe(b.ingestedAt);
  });

  it("preserves provenance through normalization", () => {
    const ledger = new InMemoryEventLedger();
    const [event] = ledger.append([draft()]).appended;

    expect(event!.source.sourceType).toBe("GITHUB_STATE");
    expect(event!.source.sourceId).toBe("pr:84");
    expect(event!.source.sourceUrl).toBe("https://github.com/o/r/pull/84");
    expect(event!.source.observedAt).toBe("2026-08-23T12:00:00Z");
    expect(event!.actor).toEqual({ type: "HUMAN", name: "50thycal" });
  });

  it("orders chronologically by when things happened, not when they were seen", () => {
    const ledger = new InMemoryEventLedger();
    ledger.append([
      draft({ occurredAt: "2026-08-23T10:00:00Z", fingerprintParts: ["late"] }),
      draft({ occurredAt: "2026-08-21T10:00:00Z", fingerprintParts: ["early"] }),
    ]);
    expect(ledger.all().map((e) => e.occurredAt)).toEqual([
      "2026-08-21T10:00:00Z",
      "2026-08-23T10:00:00Z",
    ]);
  });

  it("assigns default importance per event type", () => {
    const ledger = new InMemoryEventLedger();
    const [ci] = ledger.append([
      draft({ eventType: "CI_FAILED", fingerprintParts: ["ci-failed"] }),
    ]).appended;
    expect(ci!.importance).toBe("MAJOR");
  });
});
