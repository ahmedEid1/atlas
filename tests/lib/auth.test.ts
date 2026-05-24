import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
  clerkClient: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  },
}));

import { auth, clerkClient } from "@clerk/nextjs/server";
import { db } from "@/lib/db";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getCurrentUser — lazy-create preserves Clerk publicMetadata.isGuest", () => {
  it("returns null when there is no Clerk session", async () => {
    vi.mocked(auth).mockResolvedValue({ userId: null } as never);
    const { getCurrentUser } = await import("@/lib/auth");
    const u = await getCurrentUser();
    expect(u).toBeNull();
    expect(db.user.findUnique).not.toHaveBeenCalled();
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it("returns the existing DB user as-is when one is already provisioned", async () => {
    vi.mocked(auth).mockResolvedValue({ userId: "user_abc" } as never);
    vi.mocked(db.user.findUnique).mockResolvedValue({
      id: "u1",
      clerkId: "user_abc",
      isGuest: false,
    } as never);
    const { getCurrentUser } = await import("@/lib/auth");
    const u = await getCurrentUser();
    expect(u).toMatchObject({ id: "u1", isGuest: false });
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it("lazily-created guest preserves isGuest=true from Clerk publicMetadata", async () => {
    vi.mocked(auth).mockResolvedValue({ userId: "user_guest" } as never);
    vi.mocked(db.user.findUnique).mockResolvedValue(null);
    const getUser = vi
      .fn()
      .mockResolvedValue({ id: "user_guest", publicMetadata: { isGuest: true } });
    vi.mocked(clerkClient).mockResolvedValue({
      users: { getUser },
    } as never);
    vi.mocked(db.user.create).mockResolvedValue({
      id: "u_new",
      clerkId: "user_guest",
      isGuest: true,
    } as never);

    const { getCurrentUser } = await import("@/lib/auth");
    const u = await getCurrentUser();

    expect(getUser).toHaveBeenCalledWith("user_guest");
    expect(db.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        clerkId: "user_guest",
        isGuest: true,
      }),
    });
    expect(u?.isGuest).toBe(true);
  });

  it("lazily-created non-guest gets isGuest=false when publicMetadata is absent", async () => {
    vi.mocked(auth).mockResolvedValue({ userId: "user_real" } as never);
    vi.mocked(db.user.findUnique).mockResolvedValue(null);
    vi.mocked(clerkClient).mockResolvedValue({
      users: {
        getUser: vi.fn().mockResolvedValue({ id: "user_real", publicMetadata: {} }),
      },
    } as never);
    vi.mocked(db.user.create).mockResolvedValue({
      id: "u_new",
      clerkId: "user_real",
      isGuest: false,
    } as never);

    const { getCurrentUser } = await import("@/lib/auth");
    await getCurrentUser();

    expect(db.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ clerkId: "user_real", isGuest: false }),
    });
  });

  it("throws (does not lazy-create) when the Clerk publicMetadata lookup fails — fail-closed", async () => {
    // Regression: an earlier impl caught the Clerk error and defaulted
    // isGuest=false, which let a guest whose local row was evicted come
    // back as a non-guest during a Clerk outage and bypass every
    // guestWriteBlock guard. The fix re-throws so requireUser surfaces
    // an Unauthorized → the route returns 401 until Clerk recovers.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(auth).mockResolvedValue({ userId: "user_err" } as never);
    vi.mocked(db.user.findUnique).mockResolvedValue(null);
    vi.mocked(clerkClient).mockResolvedValue({
      users: { getUser: vi.fn().mockRejectedValue(new Error("Clerk 5xx")) },
    } as never);

    const { getCurrentUser, requireUser } = await import("@/lib/auth");
    await expect(getCurrentUser()).rejects.toThrow("Clerk 5xx");
    // Must not have lazy-created a row with the unsafe default.
    expect(db.user.create).not.toHaveBeenCalled();

    // And requireUser must surface the failure as Unauthorized-style
    // bubble (route handlers turn this into a 401).
    await expect(requireUser()).rejects.toThrow();
    expect(db.user.create).not.toHaveBeenCalled();

    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
