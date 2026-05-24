import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { cloneReviewTemplate } from "@/lib/demo/clone-review";

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
 * Side effects on success:
 *   - 1 Clerk user created (flagged isGuest in Clerk publicMetadata)
 *   - 1 row in our User table (isGuest=true)
 *   - 1 Project + N CorpusItem + Run + RunStep + IncludedPaper +
 *     ExtractedClaim + ClaimCheck rows (per cloneReviewTemplate)
 *
 * Errors:
 *   - 503 if DEMO_TEMPLATE_PROJECT_ID is unset or points to a missing
 *     project (Vercel build still succeeds; only this endpoint fails
 *     gracefully until the operator wires the env var).
 *   - 500 on Clerk / DB failure with a generic message.
 */
export async function POST() {
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

  let step = "init";
  try {
    step = "clerk_create_user";
    const clerkUser = await clerk.users.createUser({
      emailAddress: [email],
      skipPasswordRequirement: true,
      publicMetadata: { isGuest: true, source: "demo-button" },
    });
    const clerkUserId = clerkUser.id;

    step = "db_create_user";
    await db.user.create({
      data: { clerkId: clerkUserId, email, isGuest: true },
    });

    step = "lookup_atlas_user";
    const atlasUser = await db.user.findUniqueOrThrow({
      where: { clerkId: clerkUserId },
      select: { id: true },
    });

    step = "clone_template";
    await cloneReviewTemplate({
      templateProjectId,
      targetOwnerId: atlasUser.id,
    });

    step = "create_sign_in_token";
    const ticket = await clerk.signInTokens.createSignInToken({
      userId: clerkUserId,
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
