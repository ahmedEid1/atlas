import { describe, it, expect } from "vitest";
import { bucketRuns } from "@/components/runs/runs-breakdown";

describe("bucketRuns", () => {
  it("buckets a mixed list by terminal category", () => {
    const runs = [
      { status: "COMPLETED" },
      { status: "COMPLETED" },
      { status: "FAILED" },
      { status: "REJECTED" },
      { status: "DRAFTING" },
      { status: "AWAITING_DISCOVERY_APPROVAL" },
      { status: "FETCHING" },
    ];
    expect(bucketRuns(runs)).toEqual({ completed: 2, failed: 2, active: 3 });
  });

  it("returns all zeros for an empty list", () => {
    expect(bucketRuns([])).toEqual({ completed: 0, failed: 0, active: 0 });
  });

  it("treats every non-terminal V2 status as active", () => {
    const v2Active = [
      "DISCOVERING",
      "AWAITING_DISCOVERY_APPROVAL",
      "FETCHING",
      "SCREENING",
    ].map((s) => ({ status: s }));
    expect(bucketRuns(v2Active)).toEqual({ completed: 0, failed: 0, active: 4 });
  });

  it("groups REJECTED with FAILED — both are 'didn't produce a draft'", () => {
    expect(bucketRuns([{ status: "REJECTED" }])).toEqual({
      completed: 0,
      failed: 1,
      active: 0,
    });
  });

  it("ignores unknown statuses — forward-compat for new enum members", () => {
    expect(bucketRuns([{ status: "TIME_TRAVELLING" }])).toEqual({
      completed: 0,
      failed: 0,
      active: 0,
    });
  });
});
