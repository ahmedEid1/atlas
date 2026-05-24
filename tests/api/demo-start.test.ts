import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: { DEMO_TEMPLATE_PROJECT_ID: "" },
}));
vi.mock("@/lib/db", () => ({
  db: {
    project: { findUnique: vi.fn() },
    user: { create: vi.fn(), findUniqueOrThrow: vi.fn() },
  },
}));
vi.mock("@/lib/demo/clone-review", () => ({
  cloneReviewTemplate: vi.fn(),
}));
vi.mock("@clerk/nextjs/server", () => ({
  clerkClient: vi.fn(),
}));

import { env } from "@/lib/env";
import { db } from "@/lib/db";
import { cloneReviewTemplate } from "@/lib/demo/clone-review";
import { clerkClient } from "@clerk/nextjs/server";
import { POST } from "@/app/api/demo/start/route";

beforeEach(() => {
  vi.clearAllMocks();
  // Force env mock back to empty between tests
  (env as { DEMO_TEMPLATE_PROJECT_ID: string }).DEMO_TEMPLATE_PROJECT_ID = "";
});

describe("POST /api/demo/start", () => {
  it("returns 503 when DEMO_TEMPLATE_PROJECT_ID is unset", async () => {
    (env as { DEMO_TEMPLATE_PROJECT_ID: string }).DEMO_TEMPLATE_PROJECT_ID = "";
    const res = await POST();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("demo_not_configured");
  });

  it("returns 503 when the template project does not exist", async () => {
    (env as { DEMO_TEMPLATE_PROJECT_ID: string }).DEMO_TEMPLATE_PROJECT_ID = "p_missing";
    vi.mocked(db.project.findUnique).mockResolvedValue(null);
    const res = await POST();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("demo_template_missing");
  });

  it("creates a guest user, clones the template, and returns a sign-in URL", async () => {
    (env as { DEMO_TEMPLATE_PROJECT_ID: string }).DEMO_TEMPLATE_PROJECT_ID = "p_template";
    vi.mocked(db.project.findUnique).mockResolvedValue({ id: "p_template" } as never);
    vi.mocked(db.user.create).mockResolvedValue({} as never);
    vi.mocked(db.user.findUniqueOrThrow).mockResolvedValue({ id: "u_atlas_xyz" } as never);
    vi.mocked(cloneReviewTemplate).mockResolvedValue({ projectId: "p_clone" });
    const createUser = vi.fn().mockResolvedValue({ id: "user_clerk_xyz" });
    const createSignInToken = vi.fn().mockResolvedValue({
      url: "https://clerk.example.com/v1/tickets?ticket=tk_xyz",
    });
    vi.mocked(clerkClient).mockResolvedValue({
      users: { createUser },
      signInTokens: { createSignInToken },
    } as never);

    const res = await POST();
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.signInUrl).toContain("ticket=tk_xyz");
    expect(body.signInUrl).toContain("redirect_url=%2Fdashboard");

    // Verify the pipeline
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        emailAddress: [expect.stringMatching(/^guest-[a-f0-9]{12}@thoth\.demo$/)],
        skipPasswordRequirement: true,
        publicMetadata: { isGuest: true, source: "demo-button" },
      }),
    );
    expect(db.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        clerkId: "user_clerk_xyz",
        isGuest: true,
      }),
    });
    expect(cloneReviewTemplate).toHaveBeenCalledWith({
      templateProjectId: "p_template",
      targetOwnerId: "u_atlas_xyz",
    });
  });

  it("returns 500 with a generic message on provisioning failure", async () => {
    (env as { DEMO_TEMPLATE_PROJECT_ID: string }).DEMO_TEMPLATE_PROJECT_ID = "p_template";
    vi.mocked(db.project.findUnique).mockResolvedValue({ id: "p_template" } as never);
    vi.mocked(clerkClient).mockResolvedValue({
      users: { createUser: vi.fn().mockRejectedValue(new Error("Clerk down")) },
      signInTokens: { createSignInToken: vi.fn() },
    } as never);
    const res = await POST();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("demo_provision_failed");
    // The generic message must NOT leak the internal error
    expect(body.message).not.toContain("Clerk down");
  });
});
