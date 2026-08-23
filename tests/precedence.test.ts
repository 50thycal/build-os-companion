import { describe, expect, it } from "vitest";

import { precedenceOf, resolveField, type Attributed } from "../src/domain/provenance.ts";

function at<T>(value: T, sourceType: Attributed<T>["source"]["sourceType"], observedAt: string): Attributed<T> {
  return { value, source: { sourceType, sourceId: `${sourceType}:1`, observedAt } };
}

describe("source precedence", () => {
  it("orders sources as the protocol requires", () => {
    expect(precedenceOf("BUILD_OS_ARTIFACT")).toBeGreaterThan(precedenceOf("GITHUB_STATE"));
    expect(precedenceOf("GITHUB_STATE")).toBeGreaterThan(precedenceOf("SESSION_CHECKPOINT"));
    expect(precedenceOf("SESSION_CHECKPOINT")).toBeGreaterThan(precedenceOf("INFERENCE"));
  });

  it("lets a canonical artifact beat a newer session checkpoint", () => {
    const result = resolveField("workstream.phase", [
      at("BUILDING", "SESSION_CHECKPOINT", "2026-08-23T18:00:00Z"),
      at("REVIEW", "BUILD_OS_ARTIFACT", "2026-08-23T09:00:00Z"),
    ]);

    expect(result.resolved!.value).toBe("REVIEW");
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.losers[0]!.value).toBe("BUILDING");
  });

  it("lets GitHub beat an agent that claims it is done", () => {
    const result = resolveField("pr.state", [
      at("COMPLETED", "SESSION_CHECKPOINT", "2026-08-23T18:00:00Z"),
      at("OPEN", "GITHUB_STATE", "2026-08-23T17:00:00Z"),
    ]);
    expect(result.resolved!.value).toBe("OPEN");
    expect(result.conflicts).toHaveLength(1);
  });

  it("never lets inference win", () => {
    const result = resolveField("summary", [
      at("model thinks it merged", "INFERENCE", "2026-08-24T00:00:00Z"),
      at("open", "GITHUB_STATE", "2026-08-20T00:00:00Z"),
    ]);
    expect(result.resolved!.source.sourceType).toBe("GITHUB_STATE");
  });

  it("treats two readings of the same source as staleness, not conflict", () => {
    const result = resolveField("pr.state", [
      at("OPEN", "GITHUB_STATE", "2026-08-23T09:00:00Z"),
      at("MERGED", "GITHUB_STATE", "2026-08-23T18:00:00Z"),
    ]);
    expect(result.resolved!.value).toBe("MERGED");
    expect(result.conflicts).toHaveLength(0);
  });

  it("reports no conflict when sources of different authority agree", () => {
    const result = resolveField("workstream.phase", [
      at("REVIEW", "SESSION_CHECKPOINT", "2026-08-23T18:00:00Z"),
      at("REVIEW", "BUILD_OS_ARTIFACT", "2026-08-23T09:00:00Z"),
    ]);
    expect(result.conflicts).toHaveLength(0);
  });

  it("returns nothing when there is nothing to resolve", () => {
    expect(resolveField("x", []).resolved).toBeUndefined();
  });
});
