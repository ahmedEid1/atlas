import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { cloneReviewTemplate } from "@/lib/demo/clone-review";
import { checkRateLimit, extractClientIp } from "@/lib/demo/rate-limit";

/**
 * Anonymous "Try with sample data" entrypoint.
 *
 * Creates a fresh Clerk guest user, mirrors them into the local User
 * table with `isGuest = true`, deep-clones DEMO_TEMPLATE_PROJECT_ID
 * into that account, mints a Clerk sign-in ticket, and returns a URL
 * the client redirects to. The browser hits Clerk's ticket page →
 * cookie is set → user lands on /dashboard with the sample review
 * already there.
 *
 * Hardening on each request, in order:
 *   1. Per-IP sliding-window rate limit (5/hour, in-memory)
 *   2. Same-origin check (Origin/Referer must match host) in production
 *   3. Compensation on partial failure (clerk + db rollback)
 *   4. Local User + clone happen inside ONE db transaction
 *
 * Side effects on success:
 *   - 1 Clerk user created (flagged isGuest in Clerk publicMetadata)
 *   - 1 row in our User table (isGuest=true)
 *   - 1 Project + N CorpusItem + Run + RunStep + IncludedPaper +
 *     ExtractedClaim + ClaimCheck rows (per cloneReviewTemplate)
 *
 * Errors:
 *   - 429 if the caller IP has used its rate-limit budget. Sets
 *     Retry-After.
 *   - 403 if the Origin/Referer header is missing or cross-site.
 *   - 503 if DEMO_TEMPLATE_PROJECT_ID is unset or points to a missing
 *     project (Vercel build still succeeds; only this endpoint fails
 *     gracefully until the operator wires the env var).
 *   - 500 on Clerk / DB failure with a generic message. Best-effort
 *     compensation runs first.
 */
export async function POST(req: Request) {
  // --- Rate limit (before any side effects) ---
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

  // --- Origin / Referer guard (CSRF-style protection) ---
  // The endpoint is unauthenticated, so a malicious site embedding a
  // POST to /api/demo/start could otherwise burn through guest quotas
  // attributed to honest users. Enforced in production only — local dev
  // requests from curl / fetch in test runners may not set these
  // headers and we don't want to break them.
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
    const allowedPrefixes = [`https://${host}`, `http://${host}`];
    const matchesHost = (val: string | null) =>
      val ? allowedPrefixes.some((p) => val.startsWith(p)) : false;
    if (!(matchesHost(origin) || matchesHost(referer))) {
      return NextResponse.json(
        { error: "demo_invalid_origin", message: "Cross-origin request rejected." },
        { status: 403 },
      );
    }
  }

  const templateProjectId = env.DEMO_TEMPLATE_PROJECT_ID;
  if (!templateProjectId) {
    return NextResponse.json(
      {
        error: "demo_not_configured",
        message:
          "Sample-data demo is not configured. Set DEMO_TEMPLATE_PROJECT_ID in the environment.",
      },
      { status: 503 },
    );
  }

  // Verify the template exists before doing anything else — cheap query,
  // saves cleanup if the env var points at something stale.
  const templateExists = await db.project.findUnique({
    where: { id: templateProjectId },
    select: { id: true },
  });
  if (!templateExists) {
    return NextResponse.json(
      {
        error: "demo_template_missing",
        message: `DEMO_TEMPLATE_PROJECT_ID="${templateProjectId}" does not match any project in the database.`,
      },
      { status: 503 },
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
  // Each becomes non-null only after the corresponding create succeeds.
  let createdClerkUserId: string | null = null;
  let createdAtlasUserId: string | null = null;
  let createdProjectId: string | null = null;

  let step = "init";
  try {
    step = "clerk_create_user";
    const clerkUser = await clerk.users.createUser({
      emailAddress: [email],
      skipPasswordRequirement: true,
      publicMetadata: { isGuest: true, source: "demo-button" },
    });
    createdClerkUserId = clerkUser.id;

    // Local User creation + template clone run inside a single transaction.
    // If either side fails, the whole local-DB write rolls back, so we
    // only need compensation for the Clerk side (handled below).
    step = "db_user_and_clone_tx";
    const { atlasUserId, projectId } = await db.$transaction(
      async (tx) => {
        const atlasUser = await tx.user.create({
          data: { clerkId: clerkUser.id, email, isGuest: true },
          select: { id: true },
        });
        const cloned = await cloneReviewTemplate({
          templateProjectId,
          targetOwnerId: atlasUser.id,
          tx,
        });
        return { atlasUserId: atlasUser.id, projectId: cloned.projectId };
      },
      { timeout: 20_000 },
    );
    createdAtlasUserId = atlasUserId;
    createdProjectId = projectId;

    step = "create_sign_in_token";
    const ticket = await clerk.signInTokens.createSignInToken({
      userId: clerkUser.id,
      expiresInSeconds: 60,
    });
    const signInUrl = `${ticket.url}&redirect_url=${encodeURIComponent("/dashboard")}`;

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

    // Compensation — best-effort, in REVERSE order of creation so we
    // unwind cleanly. Each step is isolated in its own try/catch so a
    // compensation failure can't swallow the original error or skip
    // subsequent cleanup. Cascade behaviour:
    //   - Project: cascades to corpus + runs + steps + checkpoints +
    //     includedPapers + claims + claimChecks (per prisma/schema.prisma).
    //   - User: cascades to its Projects (and from there everything else).
    // Note: the transaction above will already have rolled back if it
    // threw, in which case createdAtlasUserId/createdProjectId stay null.
    if (createdProjectId) {
      try {
        await db.project.delete({ where: { id: createdProjectId } });
      } catch (cleanupErr) {
        console.error(
          `[demo/start] compensation: project delete failed projectId=${createdProjectId} reason=${
            cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
          }`,
        );
      }
    }
    if (createdAtlasUserId) {
      try {
        await db.user.delete({ where: { id: createdAtlasUserId } });
      } catch (cleanupErr) {
        console.error(
          `[demo/start] compensation: atlas user delete failed userId=${createdAtlasUserId} reason=${
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
