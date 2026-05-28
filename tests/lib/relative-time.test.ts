import { describe, it, expect } from "vitest";
import { relativeTime } from "@/lib/relative-time";

const now = new Date("2026-05-28T12:00:00Z").getTime();

describe("relativeTime", () => {
  it("renders <60s ago as 'just now'", () => {
    expect(relativeTime(now - 10 * 1000, now)).toBe("just now");
    expect(relativeTime(now, now)).toBe("just now");
  });

  it("renders minutes / hours / days / months / years buckets", () => {
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 minutes ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 hours ago");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2 days ago");
    // 100 days → "3 months ago" (100 / 30 = 3.3, floors to 3)
    expect(relativeTime(now - 100 * 86_400_000, now)).toBe("3 months ago");
    // 800 days → "2 years ago" (800 / 365 = 2.19, floors to 2)
    expect(relativeTime(now - 800 * 86_400_000, now)).toBe("2 years ago");
  });

  it("uses Intl.RelativeTimeFormat's auto-numeric singular form when appropriate", () => {
    // 1 minute / 1 hour / 1 day get "a minute ago" / "an hour ago" /
    // "yesterday" via numeric:'auto'. Match the locale fixture exactly.
    expect(relativeTime(now - 60_000, now)).toBe("1 minute ago");
    expect(relativeTime(now - 3_600_000, now)).toBe("1 hour ago");
    expect(relativeTime(now - 86_400_000, now)).toBe("yesterday");
  });

  it("clamps future timestamps (clock skew) to 'just now'", () => {
    expect(relativeTime(now + 5_000, now)).toBe("just now");
    expect(relativeTime(now + 60_000, now)).toBe("just now");
  });
});
