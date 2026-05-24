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

  // Mint a globally unique guest email. Clerk requires a unique email,
  // and we want the prefix to make these obvious in the dashboard +
  // make them easy to filter for the cleanup cron later.
  const guestSlug = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const email = `guest-${guestSlug}@thoth.demo`;

  const clerk = await clerkClient();

  let clerkUserId: string;
  let signInUrl: string;

  try {
    const clerkUser = await clerk.users.createUser({
      emailAddress: [email],
      skipPasswordRequirement: true,
      publicMetadata: { isGuest: true, source: "demo-button" },
    });
    clerkUserId = clerkUser.id;

    // Mirror into our User table immediately — skip the webhook race
    await db.user.create({
      data: { clerkId: clerkUserId, email, isGuest: true },
    });

    // Clone the template (Project + corpus + runs + claims + cite_check)
    const atlasUser = await db.user.findUniqueOrThrow({
      where: { clerkId: clerkUserId },
      select: { id: true },
    });
    await cloneReviewTemplate({
      templateProjectId,
      targetOwnerId: atlasUser.id,
    });

    // Mint a one-shot sign-in ticket. The returned `url` is Clerk's
    // hosted ticket consumer — the client redirects there and the
    // session cookie is set on the way back.
    const ticket = await clerk.signInTokens.createSignInToken({
      userId: clerkUserId,
      expiresInSeconds: 60,
    });
    signInUrl = `${ticket.url}&redirect_url=${encodeURIComponent("/dashboard")}`;
  } catch (err) {
    console.error("[demo/start] failed to provision guest:", err);
    // Best effort: roll back the Clerk user if we created it but a later
    // step failed. (Local User row will be removed too via webhook on
    // delete, or by the cleanup cron.)
    return NextResponse.json(
      {
        error: "demo_provision_failed",
        message: "Could not set up the demo. Please try again or sign in to a real account.",
      },
      { status: 500 },
    );
  }

  return NextResponse.json(
    { signInUrl, message: "Demo provisioned. Redirect to signInUrl." },
    { status: 201 },
  );
}
