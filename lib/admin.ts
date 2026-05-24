import { env } from "@/lib/env";

/**
 * Returns the set of admin email addresses parsed from the `ADMIN_EMAILS`
 * env var. Lowercased + trimmed. Empty Set when unset.
 *
 * Used by /admin/* pages to gate access. Lowest-tech possible
 * authorisation — no Clerk org / role plumbing, no separate admin DB
 * table. Editing the comma-separated list in the deploy env is the only
 * way to grant or revoke admin access.
 */
export function adminEmails(): Set<string> {
  const raw = env.ADMIN_EMAILS;
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0),
  );
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return adminEmails().has(email.toLowerCase());
}
