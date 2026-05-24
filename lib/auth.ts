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
 * Clerk lookup is best-effort: if it fails, we default to `isGuest=false`
 * (the safer-for-non-guests path) and log a warning so the operator can
 * investigate. We never break the request because of a Clerk read.
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
    console.warn(
      `[auth] Failed to read Clerk publicMetadata for ${userId}; defaulting isGuest=false`,
      err,
    );
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
