import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock the Clerk verifier to bypass signature checks in unit tests.
vi.mock("@clerk/nextjs/webhooks", () => ({
  verifyWebhook: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    user: {
      upsert: vi.fn().mockResolvedValue({ id: "u1" }),
      delete: vi.fn().mockResolvedValue({ id: "u1" }),
    },
  },
}));

import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { db } from "@/lib/db";

const buildReq = () =>
  new NextRequest("http://localhost/api/webhooks/clerk", {
    method: "POST",
    body: JSON.stringify({}),
  });

describe("POST /api/webhooks/clerk", () => {
  beforeEach(() => vi.clearAllMocks());

  it("upserts a non-guest user on user.created (no public_metadata.isGuest)", async () => {
    vi.mocked(verifyWebhook).mockResolvedValue({
      type: "user.created",
      data: {
        id: "user_abc",
        email_addresses: [{ email_address: "a@b.com", id: "e1" }],
        primary_email_address_id: "e1",
      },
    } as unknown as Awaited<ReturnType<typeof verifyWebhook>>);

    const { POST } = await import("@/app/api/webhooks/clerk/route");
    const res = await POST(buildReq());

    expect(res.status).toBe(200);
    expect(db.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { clerkId: "user_abc" },
        create: expect.objectContaining({
          clerkId: "user_abc",
          email: "a@b.com",
          isGuest: false,
        }),
        update: expect.objectContaining({ email: "a@b.com", isGuest: false }),
      }),
    );
  });

  it("preserves isGuest=true from public_metadata when provisioning a guest user", async () => {
    vi.mocked(verifyWebhook).mockResolvedValue({
      type: "user.created",
      data: {
        id: "user_guest",
        email_addresses: [{ email_address: "thoth-guest-x@example.com", id: "e1" }],
        primary_email_address_id: "e1",
        public_metadata: { isGuest: true, source: "demo-button" },
      },
    } as unknown as Awaited<ReturnType<typeof verifyWebhook>>);

    const { POST } = await import("@/app/api/webhooks/clerk/route");
    const res = await POST(buildReq());

    expect(res.status).toBe(200);
    expect(db.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { clerkId: "user_guest" },
        create: expect.objectContaining({
          clerkId: "user_guest",
          email: "thoth-guest-x@example.com",
          isGuest: true,
        }),
        update: expect.objectContaining({ isGuest: true }),
      }),
    );
  });

  it("on user.updated also writes isGuest from public_metadata so the flag can't drift", async () => {
    vi.mocked(verifyWebhook).mockResolvedValue({
      type: "user.updated",
      data: {
        id: "user_guest",
        email_addresses: [{ email_address: "g@example.com", id: "e1" }],
        primary_email_address_id: "e1",
        public_metadata: { isGuest: true },
      },
    } as unknown as Awaited<ReturnType<typeof verifyWebhook>>);

    const { POST } = await import("@/app/api/webhooks/clerk/route");
    const res = await POST(buildReq());

    expect(res.status).toBe(200);
    expect(db.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ isGuest: true }),
      }),
    );
  });

  it("returns 400 on verification failure", async () => {
    vi.mocked(verifyWebhook).mockRejectedValue(new Error("bad signature"));

    const { POST } = await import("@/app/api/webhooks/clerk/route");
    const res = await POST(buildReq());

    expect(res.status).toBe(400);
  });
});
