import { describe, it, expect } from "vitest";
import {
  citationRecall,
  citationPrecision,
  claimFaithfulness,
  expectedClaimCoverage,
} from "@/lib/eval/metrics";

describe("citationRecall", () => {
  it("returns 1.0 when all expected papers are included", () => {
    expect(citationRecall(["a", "b"], ["a", "b", "c"])).toBe(1);
  });
  it("returns 0.0 when no expected papers are included", () => {
    expect(citationRecall(["a", "b"], ["c", "d"])).toBe(0);
  });
  it("returns the correct fraction for partial overlap", () => {
    expect(citationRecall(["a", "b", "c", "d"], ["a", "b", "x"])).toBe(0.5);
  });
  it("returns 1.0 when expected is empty (vacuously true)", () => {
    expect(citationRecall([], ["a"])).toBe(1);
  });
});

describe("citationPrecision", () => {
  it("returns 1.0 when every included paper is expected", () => {
    expect(citationPrecision(["a", "b"], ["a", "b"])).toBe(1);
  });
  it("returns 0.5 when half the included are expected", () => {
    expect(citationPrecision(["a", "b"], ["a", "b", "c", "d"])).toBe(0.5);
  });
  it("returns 1.0 when included is empty (vacuously true)", () => {
    expect(citationPrecision(["a"], [])).toBe(1);
  });
});

describe("claimFaithfulness", () => {
  it("returns 1.0 when all claim checks are SUPPORTED", () => {
    expect(
      claimFaithfulness([
        { verdict: "SUPPORTED" },
        { verdict: "SUPPORTED" },
      ]),
    ).toBe(1);
  });
  it("returns 0.0 when none are supported", () => {
    expect(
      claimFaithfulness([
        { verdict: "UNSUPPORTED" },
        { verdict: "UNCLEAR" },
      ]),
    ).toBe(0);
  });
  it("returns the supported fraction", () => {
    expect(
      claimFaithfulness([
        { verdict: "SUPPORTED" },
        { verdict: "SUPPORTED" },
        { verdict: "UNCLEAR" },
        { verdict: "UNSUPPORTED" },
      ]),
    ).toBe(0.5);
  });
  it("returns 1.0 when no claim checks (vacuously true)", () => {
    expect(claimFaithfulness([])).toBe(1);
  });
});

describe("expectedClaimCoverage", () => {
  it("returns 1.0 when every expected claim substring appears in draft (case-insensitive)", () => {
    const draft = "The result is X improves Y by 25%. Also CBT outperforms standard care.";
    expect(
      expectedClaimCoverage(["X improves Y", "cbt outperforms"], draft),
    ).toBe(1);
  });
  it("returns 0.5 when half are present", () => {
    const draft = "The result is X improves Y by 25%.";
    expect(
      expectedClaimCoverage(["X improves Y", "CBT outperforms"], draft),
    ).toBe(0.5);
  });
  it("returns 1.0 when expected is empty (vacuously true)", () => {
    expect(expectedClaimCoverage([], "anything")).toBe(1);
  });
});
