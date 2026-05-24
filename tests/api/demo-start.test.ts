import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: { DEMO_TEMPLATE_PROJECT_ID: "", IP_HASH_SALT: "test-salt" },
}));
vi.mock("@/lib/db", () => ({
  db: {
    project: { findUnique: vi.fn(), delete: vi.fn() },
    user: { create: vi.fn(), findUniqueOrThrow: vi.fn(), delete: vi.fn() },
    $transaction: vi.fn(),
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
import { _resetRateLimitForTest } from "@/lib/demo/rate-limit";
import { POST } from "@/app/api/demo/start/route";

/** A POST request shaped like a normal browser would send. */
function buildRequest(
  opts: { ip?: string; origin?: string; referer?: string; host?: string } = {},
): Request {
  const headers: Record<string, string> = {
    "x-forwarded-for": opts.ip ?? "203.0.113.99",
  };
  if (opts.origin) headers.origin = opts.origin;
  if (opts.referer) headers.referer = opts.referer;
  if (opts.host) headers.host = opts.host;
  return new Request("http://localhost/api/demo/start", {
    method: "POST",
    headers,
  });
}

/**
 * Build a fresh suite of Clerk + DB mocks wired for a successful path.
 * Individual tests can override any mock before calling POST.
 */
function wireHappyPath(opts: {
  cloneShouldThrow?: boolean;
  txShouldThrow?: boolean;
  deleteUserImpl?: ReturnType<typeof vi.fn>;
  projectDeleteImpl?: ReturnType<typeof vi.fn>;
  userDeleteImpl?: ReturnType<typeof vi.fn>;
} = {}) {
  (env as { DEMO_TEMPLATE_PROJECT_ID: string }).DEMO_TEMPLATE_PROJECT_ID = "p_template";
  vi.mocked(db.project.findUnique).mockResolvedValue({ id: "p_template" } as never);
  vi.mocked(db.project.delete).mockImplementation(
    (opts.projectDeleteImpl ?? vi.fn().mockResolvedValue({})) as never,
  );
  vi.mocked(db.user.delete).mockImplementation(
    (opts.userDeleteImpl ?? vi.fn().mockResolvedValue({})) as never,
  );

  // $transaction(cb, opts) — call the callback with a stub tx that has a
  // user.create returning the seeded atlas user. Throw if requested.
  vi.mocked(db.$transaction).mockImplementation(
    async (cb: unknown) => {
      if (opts.txShouldThrow) {
        // Simulate the clone failing inside the tx by either calling cb
        // through to a tx where cloneReviewTemplate is mocked-to-throw,
        // OR throwing directly. We'll go through cb so callers can see
        // the failure surface like a real Prisma rollback would.
        const tx = {
          user: { create: vi.fn().mockResolvedValue({ id: "u_atlas_xyz" }) },
        };
        try {
          return await (cb as (t: unknown) => unknown)(tx);
        } catch (e) {
          throw e;
        }
      }
      const tx = {
        user: { create: vi.fn().mockResolvedValue({ id: "u_atlas_xyz" }) },
      };
      return (cb as (t: unknown) => unknown)(tx);
    },
  );

  if (opts.cloneShouldThrow) {
    vi.mocked(cloneReviewTemplate).mockRejectedValue(new Error("clone exploded"));
  } else {
    vi.mocked(cloneReviewTemplate).mockResolvedValue({ projectId: "p_clone" });
  }

  const createUser = vi.fn().mockResolvedValue({ id: "user_clerk_xyz" });
  const deleteUser = opts.deleteUserImpl ?? vi.fn().mockResolvedValue({});
  const createSignInToken = vi.fn().mockResolvedValue({
    url: "https://clerk.example.com/v1/tickets?ticket=tk_xyz",
  });
  vi.mocked(clerkClient).mockResolvedValue({
    users: { createUser, deleteUser },
    signInTokens: { createSignInToken },
  } as never);

  return { createUser, deleteUser, createSignInToken };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimitForTest();
  (env as { DEMO_TEMPLATE_PROJECT_ID: string }).DEMO_TEMPLATE_PROJECT_ID = "";
});

describe("POST /api/demo/start — config / template guards", () => {
  it("returns 503 when DEMO_TEMPLATE_PROJECT_ID is unset", async () => {
    (env as { DEMO_TEMPLATE_PROJECT_ID: string }).DEMO_TEMPLATE_PROJECT_ID = "";
    const res = await POST(buildRequest({ ip: "10.0.0.1" }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("demo_not_configured");
  });

  it("returns 503 when the template project does not exist", async () => {
    (env as { DEMO_TEMPLATE_PROJECT_ID: string }).DEMO_TEMPLATE_PROJECT_ID = "p_missing";
    vi.mocked(db.project.findUnique).mockResolvedValue(null);
    const res = await POST(buildRequest({ ip: "10.0.0.2" }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("demo_template_missing");
  });
});

describe("POST /api/demo/start — happy path", () => {
  it("creates a guest user, clones the template, and returns a sign-in URL", async () => {
    const { createUser } = wireHappyPath();

    const res = await POST(buildRequest({ ip: "10.0.0.3" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.signInUrl).toContain("ticket=tk_xyz");
    expect(body.signInUrl).toContain("redirect_url=%2Fdashboard");

    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        emailAddress: [expect.stringMatching(/^thoth-guest-[a-f0-9]{12}@example\.com$/)],
        skipPasswordRequirement: true,
        publicMetadata: { isGuest: true, source: "demo-button" },
      }),
    );
    expect(cloneReviewTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        templateProjectId: "p_template",
        targetOwnerId: "u_atlas_xyz",
      }),
    );
    // The clone is called WITH a tx (so the local User + clone share a
    // transaction) — assert that the tx param is present.
    const cloneArgs = vi.mocked(cloneReviewTemplate).mock.calls[0]![0];
    expect(cloneArgs.tx).toBeDefined();
  });
});

describe("POST /api/demo/start — rate limit", () => {
  it("returns 429 with Retry-After after 5 successful provisions from the same IP", async () => {
    wireHappyPath();

    for (let i = 0; i < 5; i++) {
      const ok = await POST(buildRequest({ ip: "203.0.113.50" }));
      expect(ok.status).toBe(201);
    }
    const denied = await POST(buildRequest({ ip: "203.0.113.50" }));
    expect(denied.status).toBe(429);
    expect(denied.headers.get("Retry-After")).toMatch(/^\d+$/);
    const body = await denied.json();
    expect(body.error).toBe("rate_limited");
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe("POST /api/demo/start — origin / referer guard (production only)", () => {
  it("rejects a cross-origin request with 403 demo_invalid_origin", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      wireHappyPath();
      const res = await POST(
        new Request("http://localhost/api/demo/start", {
          method: "POST",
          headers: {
            "x-forwarded-for": "203.0.113.77",
            host: "thoth.example.com",
            origin: "https://attacker.example.org",
          },
        }),
      );
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("demo_invalid_origin");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("allows a same-origin request in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      wireHappyPath();
      const res = await POST(
        new Request("http://localhost/api/demo/start", {
          method: "POST",
          headers: {
            "x-forwarded-for": "203.0.113.78",
            host: "thoth.example.com",
            origin: "https://thoth.example.com",
          },
        }),
      );
      expect(res.status).toBe(201);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("POST /api/demo/start — compensation on partial failure", () => {
  it("returns 500 with a generic message on initial Clerk failure (no compensation needed)", async () => {
    (env as { DEMO_TEMPLATE_PROJECT_ID: string }).DEMO_TEMPLATE_PROJECT_ID = "p_template";
    vi.mocked(db.project.findUnique).mockResolvedValue({ id: "p_template" } as never);
    const deleteUser = vi.fn();
    vi.mocked(clerkClient).mockResolvedValue({
      users: {
        createUser: vi.fn().mockRejectedValue(new Error("Clerk down")),
        deleteUser,
      },
      signInTokens: { createSignInToken: vi.fn() },
    } as never);

    const res = await POST(buildRequest({ ip: "10.0.0.50" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("demo_provision_failed");
    // The generic message must NOT leak the internal error
    expect(body.message).not.toContain("Clerk down");
    // No clerk user was created → nothing to compensate.
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("rolls back the Clerk user when the cloneReviewTemplate step throws", async () => {
    const { deleteUser } = wireHappyPath({ cloneShouldThrow: true });

    const res = await POST(buildRequest({ ip: "10.0.0.51" }));
    expect(res.status).toBe(500);

    // The local DB transaction rolled back automatically (clone threw
    // inside it), so we should NOT have called db.user.delete or
    // db.project.delete — but the Clerk user IS a real side effect and
    // must be cleaned up.
    expect(deleteUser).toHaveBeenCalledWith("user_clerk_xyz");
    expect(db.user.delete).not.toHaveBeenCalled();
    expect(db.project.delete).not.toHaveBeenCalled();
  });

  it("rolls back Clerk + Project + Atlas user when the sign-in-token step throws", async () => {
    // Wire the happy path, then override createSignInToken to throw so
    // the failure happens AFTER the local-DB transaction committed.
    const createUser = vi.fn().mockResolvedValue({ id: "user_clerk_xyz" });
    const deleteUser = vi.fn().mockResolvedValue({});
    const createSignInToken = vi.fn().mockRejectedValue(new Error("ticket service down"));

    (env as { DEMO_TEMPLATE_PROJECT_ID: string }).DEMO_TEMPLATE_PROJECT_ID = "p_template";
    vi.mocked(db.project.findUnique).mockResolvedValue({ id: "p_template" } as never);
    vi.mocked(db.project.delete).mockResolvedValue({} as never);
    vi.mocked(db.user.delete).mockResolvedValue({} as never);
    vi.mocked(cloneReviewTemplate).mockResolvedValue({ projectId: "p_clone" });
    vi.mocked(db.$transaction).mockImplementation(async (cb: unknown) => {
      const tx = {
        user: { create: vi.fn().mockResolvedValue({ id: "u_atlas_xyz" }) },
      };
      return (cb as (t: unknown) => unknown)(tx);
    });
    vi.mocked(clerkClient).mockResolvedValue({
      users: { createUser, deleteUser },
      signInTokens: { createSignInToken },
    } as never);

    const res = await POST(buildRequest({ ip: "10.0.0.52" }));
    expect(res.status).toBe(500);

    // All three side effects must be compensated, in reverse order.
    expect(db.project.delete).toHaveBeenCalledWith({ where: { id: "p_clone" } });
    expect(db.user.delete).toHaveBeenCalledWith({ where: { id: "u_atlas_xyz" } });
    expect(deleteUser).toHaveBeenCalledWith("user_clerk_xyz");
  });

  it("does not let a compensation failure mask the original error", async () => {
    // Clone throws → only Clerk user exists. Make the Clerk-delete also
    // throw. We should still get the 500 response, not a different error.
    const deleteUser = vi.fn().mockRejectedValue(new Error("clerk also down"));
    wireHappyPath({ cloneShouldThrow: true, deleteUserImpl: deleteUser });

    const res = await POST(buildRequest({ ip: "10.0.0.53" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("demo_provision_failed");
    expect(deleteUser).toHaveBeenCalledWith("user_clerk_xyz");
  });
});
