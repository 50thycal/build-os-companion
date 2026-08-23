import { describe, expect, it } from "vitest";

import { validateCheckpoint } from "../src/ingest/checkpoint/validate.ts";
import {
  applyStaleness,
  normalizeCheckpoint,
  toSessionState,
} from "../src/ingest/checkpoint/normalize.ts";
import { DEFAULT_THRESHOLDS } from "../src/domain/attention.ts";
import { fixtureJson } from "./helpers.ts";

const CONTEXT = {
  projectId: "proj_cargo_ship",
  checkpointSource: "API" as const,
  receivedAt: "2026-08-23T18:00:05Z",
};

describe("checkpoint validation", () => {
  it("accepts a well-formed checkpoint", () => {
    const result = validateCheckpoint(fixtureJson("checkpoints", "valid-active.json"));
    expect(result.ok).toBe(true);
  });

  it("rejects a checkpoint carrying a transcript", () => {
    const result = validateCheckpoint(fixtureJson("checkpoints", "invalid-transcript.json"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/additional propert/i);
    }
  });

  it("rejects a contract version it does not understand", () => {
    const result = validateCheckpoint(fixtureJson("checkpoints", "invalid-unknown-version.json"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("unsupported schema_version");
  });

  it("refuses to let an agent claim UNKNOWN for itself", () => {
    const result = validateCheckpoint(fixtureJson("checkpoints", "invalid-claims-unknown.json"));
    expect(result.ok).toBe(false);
  });

  it("rejects anything that is not an object", () => {
    expect(validateCheckpoint("a transcript, honestly").ok).toBe(false);
    expect(validateCheckpoint(null).ok).toBe(false);
  });
});

describe("checkpoint normalization", () => {
  const checkpoint = fixtureJson<Record<string, unknown>>("checkpoints", "valid-active.json");
  const parsed = validateCheckpoint(checkpoint);
  if (!parsed.ok) throw new Error("fixture must be valid");

  it("emits a session-started event the first time it sees a session", () => {
    const drafts = normalizeCheckpoint(parsed.checkpoint, CONTEXT);
    expect(drafts.map((d) => d.eventType)).toEqual(["SESSION_STARTED"]);
    expect(drafts[0]!.source.sourceType).toBe("SESSION_CHECKPOINT");
  });

  it("emits a routine checkpoint when nothing changed but time passed", () => {
    const previous = toSessionState(parsed.checkpoint, CONTEXT);
    const later = { ...parsed.checkpoint, updated_at: "2026-08-23T19:00:00Z" };
    const drafts = normalizeCheckpoint(later, CONTEXT, previous);
    expect(drafts.map((d) => d.eventType)).toEqual(["SESSION_CHECKPOINTED"]);
  });

  it("emits SESSION_BLOCKED when the status changes to blocked", () => {
    const blockedRaw = fixtureJson<Record<string, unknown>>("checkpoints", "blocked-on-owner.json");
    const blocked = validateCheckpoint(blockedRaw);
    if (!blocked.ok) throw new Error("fixture must be valid");

    const previous = toSessionState(
      { ...blocked.checkpoint, status: "ACTIVE" },
      CONTEXT,
    );
    const drafts = normalizeCheckpoint(blocked.checkpoint, CONTEXT, previous);
    expect(drafts.map((d) => d.eventType)).toContain("SESSION_BLOCKED");
    expect(drafts[0]!.summaryShort).toContain("Prize-payout rules");
  });

  it("keeps the original start time across checkpoints", () => {
    const first = toSessionState(parsed.checkpoint, CONTEXT);
    const second = toSessionState(
      { ...parsed.checkpoint, updated_at: "2026-08-23T20:00:00Z" },
      CONTEXT,
      first,
    );
    expect(second.startedAt).toBe(first.startedAt);
    expect(second.updatedAt).toBe("2026-08-23T20:00:00Z");
  });
});

describe("session staleness", () => {
  const base = toSessionState(
    { ...(fixtureJson("checkpoints", "valid-active.json") as any) },
    CONTEXT,
  );

  it("demotes a silent active session to UNKNOWN, never COMPLETED", () => {
    const now = new Date("2026-08-24T06:00:00Z");
    const [session] = applyStaleness([base], now, DEFAULT_THRESHOLDS);

    expect(session!.status).toBe("UNKNOWN");
    expect(session!.stale).toBe(true);
    expect(session!.completedAt).toBeUndefined();
  });

  it("leaves a session that checkpointed recently alone", () => {
    const now = new Date("2026-08-23T19:00:00Z");
    const [session] = applyStaleness([base], now, DEFAULT_THRESHOLDS);
    expect(session!.status).toBe("ACTIVE");
    expect(session!.stale).toBe(false);
  });

  it("marks a silent blocked session stale but keeps it blocked", () => {
    const blocked = { ...base, status: "BLOCKED" as const };
    const [session] = applyStaleness([blocked], new Date("2026-08-25T00:00:00Z"), DEFAULT_THRESHOLDS);
    expect(session!.status).toBe("BLOCKED");
    expect(session!.stale).toBe(true);
  });

  it("does not disturb a session that already completed", () => {
    const completed = { ...base, status: "COMPLETED" as const };
    const [session] = applyStaleness([completed], new Date("2026-09-01T00:00:00Z"), DEFAULT_THRESHOLDS);
    expect(session!.status).toBe("COMPLETED");
  });
});
