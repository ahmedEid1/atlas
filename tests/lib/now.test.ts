import { describe, it, expect } from "vitest";
import { nowSnapshot } from "@/lib/now";

describe("nowSnapshot", () => {
  it("returns a finite ms timestamp", () => {
    const t = nowSnapshot();
    expect(Number.isFinite(t)).toBe(true);
    expect(t).toBeGreaterThan(0);
  });

  it("returns a value within a tight window of Date.now() (sanity check)", () => {
    // The helper IS Date.now() — confirm it isn't accidentally
    // re-implemented as a constant or build-time inline.
    const before = Date.now();
    const t = nowSnapshot();
    const after = Date.now();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });
});
