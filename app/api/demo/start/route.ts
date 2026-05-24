import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { checkRateLimit, extractClientIp } from "@/lib/demo/rate-limit";

/**
 * Anonymous "Try the live demo" entrypoint.
 *
 * Creates a fresh Clerk guest user, mirrors them into the local User
 * table with `isGuest = true`, mints a Clerk sign-in ticket, and
 * returns a URL the client redirects to. The browser hits our
 * /demo/handoff page → ticket is consumed via signIn.create() → user
 * lands on /dashboard with an empty workspace where they can start
 * their own review.
 *
 * (Earlier iterations of this endpoint deep-cloned a canonical
 * "sample" SLR into the guest's account so visitors had immediate
 * data to explore. We removed that — guests should experience the
 * real flow: upload PDFs, run the agent, see cite_check fire in real
 * time. The cloneReviewTemplate helper + its tests stay in the
 * repo for potential future re-enable, but are not on this code path.)
 *
 * Hardening on each request, in order:
 *   1. Same-origin check (Origin/Referer must match host) in production —
 *      runs BEFORE rate-limit so cross-site posts can't drain a victim
 *      IP's quota (DoS amplifier).
 *   2. Per-IP sliding-window rate limit (5/hour, in-memory) — only
 *      consumed by requests that pass the origin check.
 *   3. Compensation on partial failure (clerk + db rollback).
 *
 * Side effects on success:
 *   - 1 Clerk user created (flagged isGuest in Clerk publicMetadata)
 *   - 1 row in our User table (isGuest=true)
 *
 * Errors:
 *   - 429 if the caller IP has used its rate-limit budget. Sets Retry-After.
 *   - 403 if the Origin/Referer header is missing or cross-site.
 *   - 500 on Clerk / DB failure with a generic message. Best-effort
 *     compensation runs first.
 */
export async function POST(req: Request) {
  // --- Operator kill switch ---
  // Short-circuits BEFORE the origin / rate-limit / Clerk / DB work. Set
  // DEMO_DISABLED="1" in the Vercel env to pause guest provisioning
  // without a deploy — useful when a traffic spike threatens to exhaust
  // free-tier Clerk MAU / Mistral RPS / Neon compute.
  if (env.DEMO_DISABLED === "1") {
    return NextResponse.json(
      {
        error: "demo_disabled",
        message:
          "The anonymous demo is temporarily paused. Sign up for a free account to use Thoth, or try again later.",
      },
      { status: 503 },
    );
  }

  // --- Origin / Referer guard (CSRF-style protection) ---
  // The endpoint is unauthenticated, so a malicious site embedding a
  // POST to /api/demo/start could otherwise burn through guest quotas
  // attributed to honest users. Enforced in production only — local dev
  // requests from curl / fetch in test runners may not set these
  // headers and we don't want to break them.
  //
  // Runs BEFORE the rate-limit check on purpose: if we rate-limited
  // first, a cross-site POST from a victim's browser would still drain
  // that victim IP's per-hour bucket even though we reject it.
  //
  // Origin comparison parses through `new URL().origin` and matches
  // against an exact Set — `host.evil.tld` is rejected because its
  // `.origin` doesn't match `https://${host}` exactly.
  if (process.env.NODE_ENV === "production") {
    const host = req.headers.get("host");
    const origin = req.headers.get("origin");
    const referer = req.headers.get("referer");
    if (!host || (!origin && !referer)) {
      return NextResponse.json(
        { error: "demo_invalid_origin", message: "Missing Origin/Referer header." },
        { status: 403 },
      );
    }
    const expectedOrigins = new Set([`https://${host}`, `http://${host}`]);
    const isAllowedOrigin = (val: string | null): boolean => {
      if (!val) return false;
      try {
        return expectedOrigins.has(new URL(val).origin);
      } catch {
        return false;
      }
    };
    if (!(isAllowedOrigin(origin) || isAllowedOrigin(referer))) {
      return NextResponse.json(
        { error: "demo_invalid_origin", message: "Cross-origin request rejected." },
        { status: 403 },
      );
    }
  }

  // --- Rate limit (after origin check, before any side effects) ---
  const ip = extractClientIp(req.headers);
  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "rate_limited", retryAfterSeconds: limit.retryAfterSeconds },
      {
        status: 429,
        headers: { "Retry-After": String(limit.retryAfterSeconds) },
      },
    );
  }

  // Mint a globally unique guest email. Clerk's email validator
  // requires a real, resolvable domain — `.demo` and `.test` (RFC 2606
  // reserved-for-testing) are both rejected. `@example.com` IS reserved
  // by RFC 2606 for documentation use, resolves in DNS, and is accepted
  // by Clerk. The `guest-<12hex>-` prefix keeps these obvious in the
  // Clerk dashboard and easy to filter for the cleanup cron later.
  const guestSlug = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const email = `thoth-guest-${guestSlug}@example.com`;

  const clerk = await clerkClient();

  // Track what we've created so the catch block can compensate cleanly.
  let createdClerkUserId: string | null = null;
  let createdLocalUserId: string | null = null;

  let step = "init";
  try {
    step = "clerk_create_user";
    const clerkUser = await clerk.users.createUser({
      emailAddress: [email],
      skipPasswordRequirement: true,
      publicMetadata: { isGuest: true, source: "demo-button" },
    });
    createdClerkUserId = clerkUser.id;

    step = "db_create_user";
    const localUser = await db.user.create({
      data: { clerkId: clerkUser.id, email, isGuest: true },
      select: { id: true },
    });
    createdLocalUserId = localUser.id;

    step = "create_sign_in_token";
    const ticket = await clerk.signInTokens.createSignInToken({
      userId: clerkUser.id,
      expiresInSeconds: 60,
    });

    // Build an absolute URL to OUR handoff page. We send the ticket to
    // /demo/handoff (a tiny client component that calls signIn.create()
    // and then navigates to /dashboard) instead of redirecting the
    // browser directly to Clerk's accounts.dev ticket URL. Clerk's
    // accounts.dev ticket page processes the ticket but, on dev
    // instances or when the destination isn't whitelisted in the Clerk
    // dashboard, ignores ?redirect_url= and bounces the user to
    // /default-redirect ("Welcome — Clerk cannot redirect to your
    // application"). Consuming the ticket in our own app via the SDK
    // sidesteps that.
    //
    // x-forwarded-proto is sanitized because proxies may set comma-
    // separated chains and the header is attacker-controllable on
    // misconfigured edges; only "http"/"https" pass through.
    const reqHost = req.headers.get("host") ?? "";
    const rawProto = req.headers.get("x-forwarded-proto");
    const firstProto = rawProto?.split(",")[0]?.trim().toLowerCase();
    const isValidProto = firstProto === "http" || firstProto === "https";
    const reqProto = isValidProto
      ? firstProto
      : reqHost.startsWith("localhost") || reqHost.startsWith("127.")
        ? "http"
        : "https";
    const handoffUrl = new URL("/demo/handoff", `${reqProto}://${reqHost}`);
    handoffUrl.searchParams.set("ticket", ticket.token);
    const signInUrl = handoffUrl.toString();

    return NextResponse.json(
      { signInUrl, message: "Demo provisioned. Redirect to signInUrl." },
      { status: 201 },
    );
  } catch (err) {
    // Log the step + the full error so Vercel runtime logs surface the
    // root cause. The client-facing message stays generic so we don't
    // leak internals to anonymous callers.
    const errMsg = err instanceof Error ? err.message : String(err);
    const errStack = err instanceof Error ? err.stack : undefined;
    console.error(
      `[demo/start] FAILED at step="${step}" email="${email}" message="${errMsg}"\nstack=${errStack}`,
    );

    // Compensation — best-effort, in REVERSE order of creation. Each
    // step is isolated in its own try/catch so a compensation failure
    // can't swallow the original error or skip subsequent cleanup.
    if (createdLocalUserId) {
      try {
        await db.user.delete({ where: { id: createdLocalUserId } });
      } catch (cleanupErr) {
        console.error(
          `[demo/start] compensation: local user delete failed userId=${createdLocalUserId} reason=${
            cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
          }`,
        );
      }
    }
    if (createdClerkUserId) {
      try {
        await clerk.users.deleteUser(createdClerkUserId);
      } catch (cleanupErr) {
        console.error(
          `[demo/start] compensation: clerk user delete failed clerkId=${createdClerkUserId} reason=${
            cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
          }`,
        );
      }
    }

    return NextResponse.json(
      {
        error: "demo_provision_failed",
        step,
        message: "Could not set up the demo. Please try again or sign in to a real account.",
      },
      { status: 500 },
    );
  }
}
