import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: { IP_HASH_SALT: "test-salt", DEMO_DISABLED: undefined },
}));
vi.mock("@/lib/db", () => ({
  db: {
    user: { create: vi.fn(), delete: vi.fn() },
  },
}));
vi.mock("@clerk/nextjs/server", () => ({
  clerkClient: vi.fn(),
}));

import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { clerkClient } from "@clerk/nextjs/server";
import { _resetRateLimitForTest } from "@/lib/demo/rate-limit";
import { POST } from "@/app/api/demo/start/route";

/** A POST request shaped like a normal browser would send. */
function buildRequest(
  opts: { ip?: string; origin?: string; referer?: string; host?: string } = {},
): Request {
  const headers: Record<string, string> = {
    "x-forwarded-for": opts.ip ?? "203.0.113.99",
    // Node's Request constructor doesn't auto-populate `host` from the
    // URL; the route needs it to build the absolute /demo/handoff URL.
    host: opts.host ?? "localhost",
  };
  if (opts.origin) headers.origin = opts.origin;
  if (opts.referer) headers.referer = opts.referer;
  return new Request("http://localhost/api/demo/start", {
    method: "POST",
    headers,
  });
}

/**
 * Build a fresh suite of Clerk + DB mocks wired for a successful path.
 * Individual tests can override any mock before calling POST.
 */
function wireHappyPath(opts: { deleteUserImpl?: ReturnType<typeof vi.fn> } = {}) {
  vi.mocked(db.user.create).mockResolvedValue({ id: "u_local_xyz" } as never);
  vi.mocked(db.user.delete).mockResolvedValue({} as never);

  const createUser = vi.fn().mockResolvedValue({ id: "user_clerk_xyz" });
  const deleteUser = opts.deleteUserImpl ?? vi.fn().mockResolvedValue({});
  const createSignInToken = vi.fn().mockResolvedValue({
    // The route reads ticket.token (handed to /demo/handoff). ticket.url
    // also comes back on the real response — included on the mock for
    // forward-compat with anything that may inspect it.
    token: "tk_xyz",
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
  (env as { DEMO_DISABLED: string | undefined }).DEMO_DISABLED = undefined;
});

describe("POST /api/demo/start — operator kill switch (DEMO_DISABLED)", () => {
  it("returns 503 demo_disabled and runs no side effects when DEMO_DISABLED=1", async () => {
    wireHappyPath();
    (env as { DEMO_DISABLED: string | undefined }).DEMO_DISABLED = "1";
    const res = await POST(buildRequest({ ip: "10.0.0.4" }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("demo_disabled");
    // No Clerk or DB calls — the switch short-circuits before any side effect.
    expect(db.user.create).not.toHaveBeenCalled();
    expect(clerkClient).not.toHaveBeenCalled();
  });

  it("ignores DEMO_DISABLED values other than '1' (proceeds normally)", async () => {
    wireHappyPath();
    for (const v of ["", "0", "true", "false", undefined]) {
      (env as { DEMO_DISABLED: string | undefined }).DEMO_DISABLED = v;
      const res = await POST(buildRequest({ ip: `10.0.0.${100 + (v?.length ?? 0)}` }));
      expect(res.status).toBe(201);
    }
  });
});

describe("POST /api/demo/start — happy path", () => {
  it("creates a guest Clerk user, a local User row, and returns a handoff URL", async () => {
    const { createUser } = wireHappyPath();

    const res = await POST(buildRequest({ ip: "10.0.0.3" }));
    expect(res.status).toBe(201);
    const body = await res.json();

    // signInUrl points at our own /demo/handoff page (not Clerk's
    // accounts.dev ticket URL). Clerk's ticket URL bounced dev
    // instances to /default-redirect; consuming the ticket client-side
    // via signIn.create() avoids that and gives us a branded loading
    // state.
    expect(body.signInUrl).toContain("/demo/handoff");
    expect(body.signInUrl).toContain("ticket=tk_xyz");
    // Absolute URL — the host header drives the origin so it works
    // identically across localhost, preview deploys, and production.
    expect(body.signInUrl).toMatch(/^http:\/\/localhost\/demo\/handoff\?ticket=/);

    // Clerk user is created with the guest flag in publicMetadata so
    // the cleanup cron can find it.
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        emailAddress: [expect.stringMatching(/^thoth-guest-[a-f0-9]{12}@example\.com$/)],
        skipPasswordRequirement: true,
        publicMetadata: { isGuest: true, source: "demo-button" },
      }),
    );

    // Local User row is mirrored with isGuest=true.
    expect(db.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          clerkId: "user_clerk_xyz",
          isGuest: true,
        }),
      }),
    );
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

  it("rejects a malicious-suffix Origin like host.evil.tld (no startsWith bypass)", async () => {
    // Regression: earlier impl used origin.startsWith("https://" + host)
    // which let `https://demo.thoth.app.evil.tld` slip past. The fix
    // parses Origin through new URL().origin so the comparison is exact.
    vi.stubEnv("NODE_ENV", "production");
    try {
      wireHappyPath();
      const res = await POST(
        new Request("http://localhost/api/demo/start", {
          method: "POST",
          headers: {
            "x-forwarded-for": "203.0.113.79",
            host: "demo.thoth.app",
            origin: "https://demo.thoth.app.evil.tld",
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

  it("does not consume rate-limit budget on cross-origin reject", async () => {
    // Regression: earlier impl ran rate-limit BEFORE origin, so cross-
    // site POSTs from a victim's browser drained the victim IP's bucket
    // — DoS amplifier. With origin first, 10 cross-origin attempts must
    // NOT eat into the bucket; a follow-up same-origin request still
    // succeeds.
    vi.stubEnv("NODE_ENV", "production");
    try {
      wireHappyPath();
      const sharedIp = "203.0.113.80";
      for (let i = 0; i < 10; i++) {
        const denied = await POST(
          new Request("http://localhost/api/demo/start", {
            method: "POST",
            headers: {
              "x-forwarded-for": sharedIp,
              host: "thoth.example.com",
              origin: "https://attacker.example.org",
            },
          }),
        );
        expect(denied.status).toBe(403);
      }
      const ok = await POST(
        new Request("http://localhost/api/demo/start", {
          method: "POST",
          headers: {
            "x-forwarded-for": sharedIp,
            host: "thoth.example.com",
            origin: "https://thoth.example.com",
          },
        }),
      );
      expect(ok.status).toBe(201);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("ignores malicious x-forwarded-proto values like 'https://attacker.example'", async () => {
    // Regression: earlier impl interpolated x-forwarded-proto raw into
    // `${proto}://${host}`. A value like "https://attacker.example"
    // would have steered the redirect off-site. Sanitization rejects
    // anything that isn't exactly "http" or "https".
    wireHappyPath();
    const res = await POST(
      new Request("http://localhost/api/demo/start", {
        method: "POST",
        headers: {
          "x-forwarded-for": "203.0.113.90",
          host: "localhost",
          "x-forwarded-proto": "https://attacker.example",
        },
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.signInUrl).toMatch(/^http:\/\/localhost\/demo\/handoff\?ticket=/);
    expect(body.signInUrl).not.toContain("attacker.example");
  });

  it("uses the FIRST token from a comma-separated x-forwarded-proto chain", async () => {
    wireHappyPath();
    const res = await POST(
      new Request("http://localhost/api/demo/start", {
        method: "POST",
        headers: {
          "x-forwarded-for": "203.0.113.91",
          host: "thoth.app",
          "x-forwarded-proto": "https,http",
        },
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.signInUrl).toMatch(/^https:\/\/thoth\.app\/demo\/handoff\?ticket=/);
  });

  it("rejects non-http/https protos (javascript:, file:) and falls back to the host heuristic", async () => {
    for (const bad of ["javascript:", "file:", "data:", "ftp"]) {
      wireHappyPath();
      const res = await POST(
        new Request("http://localhost/api/demo/start", {
          method: "POST",
          headers: {
            "x-forwarded-for": `203.0.113.${100 + bad.length}`,
            host: "localhost",
            "x-forwarded-proto": bad,
          },
        }),
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.signInUrl).toMatch(/^http:\/\/localhost\/demo\/handoff\?ticket=/);
      _resetRateLimitForTest();
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

  it("rolls back the Clerk user when db.user.create throws", async () => {
    const { deleteUser } = wireHappyPath();
    vi.mocked(db.user.create).mockRejectedValue(new Error("db down"));

    const res = await POST(buildRequest({ ip: "10.0.0.51" }));
    expect(res.status).toBe(500);

    // Clerk user is a real side effect that must be cleaned up.
    expect(deleteUser).toHaveBeenCalledWith("user_clerk_xyz");
    // db.user.create threw → no local user row to delete.
    expect(db.user.delete).not.toHaveBeenCalled();
  });

  it("rolls back Clerk + local user when createSignInToken throws", async () => {
    const createUser = vi.fn().mockResolvedValue({ id: "user_clerk_xyz" });
    const deleteUser = vi.fn().mockResolvedValue({});
    const createSignInToken = vi.fn().mockRejectedValue(new Error("ticket service down"));

    vi.mocked(db.user.create).mockResolvedValue({ id: "u_local_xyz" } as never);
    vi.mocked(db.user.delete).mockResolvedValue({} as never);
    vi.mocked(clerkClient).mockResolvedValue({
      users: { createUser, deleteUser },
      signInTokens: { createSignInToken },
    } as never);

    const res = await POST(buildRequest({ ip: "10.0.0.52" }));
    expect(res.status).toBe(500);

    // Both side effects must be compensated, local user first then Clerk.
    expect(db.user.delete).toHaveBeenCalledWith({ where: { id: "u_local_xyz" } });
    expect(deleteUser).toHaveBeenCalledWith("user_clerk_xyz");
  });

  it("does not let a compensation failure mask the original error", async () => {
    // db.user.create throws → only Clerk user exists. Make the Clerk-
    // delete also throw. We should still get the 500 response, not a
    // different error.
    const deleteUser = vi.fn().mockRejectedValue(new Error("clerk also down"));
    wireHappyPath({ deleteUserImpl: deleteUser });
    vi.mocked(db.user.create).mockRejectedValue(new Error("db exploded"));

    const res = await POST(buildRequest({ ip: "10.0.0.53" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("demo_provision_failed");
    expect(deleteUser).toHaveBeenCalledWith("user_clerk_xyz");
  });
});
