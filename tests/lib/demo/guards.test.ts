import { describe, it, expect } from "vitest";
import { guestWriteBlock } from "@/lib/demo/guards";

describe("guestWriteBlock", () => {
  it("returns null for a real (non-guest) user", () => {
    expect(guestWriteBlock({ isGuest: false })).toBeNull();
  });

  it("returns a 403 NextResponse for a guest user", async () => {
    const res = guestWriteBlock({ isGuest: true });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    const body = await res!.json();
    expect(body.error).toBe("demo_mode_readonly");
    expect(typeof body.message).toBe("string");
  });
});
