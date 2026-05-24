import { auth, clerkClient } from "@clerk/nextjs/server";
import { db } from "@/lib/db";

/**
 * Returns the DB User row for the current Clerk session, lazy-creating
 * one if the webhook hasn't fired yet (race protection).
 *
 * IMPORTANT: when lazy-creating, we MUST read `publicMetadata.isGuest`
 * from Clerk before inserting. Otherwise a guest whose DB row was
 * evicted/deleted would silently come back as `isGuest=false` (column
 * default) and bypass `guestWriteBlock` guards.
 *
 * Fail-closed on Clerk read failure: if the Clerk lookup throws (5xx,
 * network blip, etc.), we re-throw rather than defaulting to
 * `isGuest=false`. Defaulting would let a guest whose local row was
 * evicted come back as a non-guest during a Clerk outage and slip past
 * every `guestWriteBlock` guard in the app. The fail-closed path lets
 * the error bubble up to `requireUser` → the route returns 401. Trade:
 *   - Real users see a transient 401 during a Clerk outage; retrying
 *     after Clerk recovers succeeds.
 *   - Guests see a 401 and can't escalate. Acceptable cost because
 *     Clerk outages are rare and write-guard integrity is the higher
 *     value.
 */
export async function getCurrentUser() {
  const { userId } = await auth();
  if (!userId) return null;

  const existing = await db.user.findUnique({ where: { clerkId: userId } });
  if (existing) return existing;

  let isGuest = false;
  try {
    const clerk = await clerkClient();
    const clerkUser = await clerk.users.getUser(userId);
    isGuest = clerkUser.publicMetadata?.isGuest === true;
  } catch (err) {
    console.error(
      `[auth] Clerk metadata read failed for ${userId} during lazy-create — failing closed to protect guest write-guards. Retry after Clerk recovers.`,
      err,
    );
    throw err;
  }

  return db.user.create({
    data: { clerkId: userId, email: `${userId}@pending.local`, isGuest },
  });
}

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) throw new Error("Unauthorized");
  return user;
}
