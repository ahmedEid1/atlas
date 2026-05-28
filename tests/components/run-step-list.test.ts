import { describe, it, expect } from "vitest";
import { formatStepDuration, nodeLabel } from "@/components/runs/run-step-list";

describe("formatStepDuration", () => {
  it("sub-second values render as a 1-decimal seconds string", () => {
    expect(formatStepDuration(0)).toBe("0.0s");
    expect(formatStepDuration(400)).toBe("0.4s");
    expect(formatStepDuration(999)).toBe("1.0s");
  });

  it("integer seconds for 1s..59s", () => {
    expect(formatStepDuration(1000)).toBe("1s");
    expect(formatStepDuration(12_345)).toBe("12s");
    expect(formatStepDuration(59_999)).toBe("59s");
  });

  it("minutes + seconds for 1m..59m, omitting 0s suffix", () => {
    expect(formatStepDuration(60_000)).toBe("1m");
    expect(formatStepDuration(83_000)).toBe("1m 23s");
    expect(formatStepDuration(120_000)).toBe("2m");
    expect(formatStepDuration(3_599_000)).toBe("59m 59s");
  });

  it("hours + minutes for >=1h, omitting 0m suffix", () => {
    expect(formatStepDuration(3_600_000)).toBe("1h");
    expect(formatStepDuration(3_900_000)).toBe("1h 5m");
    expect(formatStepDuration(7_320_000)).toBe("2h 2m");
  });

  it("clamps negative or non-finite to 0s — wall-clock skew shouldn't render '-3s'", () => {
    expect(formatStepDuration(-5)).toBe("0s");
    expect(formatStepDuration(NaN)).toBe("0s");
    expect(formatStepDuration(Infinity)).toBe("0s");
  });
});

describe("nodeLabel", () => {
  it("maps known outer nodes to humanised verb-y labels", () => {
    expect(nodeLabel("planner")).toBe("Planning the review");
    expect(nodeLabel("retriever")).toBe("Retrieving papers");
    expect(nodeLabel("discoverer")).toBe("Discovering outbound papers");
    expect(nodeLabel("fetcher")).toBe("Fetching paper metadata");
    expect(nodeLabel("screener")).toBe("Screening papers");
    expect(nodeLabel("assessor")).toBe("Assessing papers");
    expect(nodeLabel("drafter")).toBe("Drafting the review");
    expect(nodeLabel("critic")).toBe("Reviewing the draft");
    expect(nodeLabel("cite_check")).toBe("Verifying citations");
  });

  it("singularises inner per-item nodes", () => {
    expect(nodeLabel("retriever_paper")).toBe("Reading paper");
    expect(nodeLabel("fetcher_paper")).toBe("Fetching paper");
    expect(nodeLabel("screener_paper")).toBe("Screening paper");
    expect(nodeLabel("assessor_paper")).toBe("Assessing paper");
    expect(nodeLabel("cite_check_citation")).toBe("Verifying citation");
  });

  it("falls through to the raw nodeName for unknown nodes — forward-compat", () => {
    expect(nodeLabel("nascent_node")).toBe("nascent_node");
    expect(nodeLabel("")).toBe("");
  });
});
