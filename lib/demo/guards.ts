import { NextResponse } from "next/server";

/**
 * Returns a 403 NextResponse when the user is a guest — used by write
 * endpoints to prevent demo visitors from burning LLM budget by
 * starting new reviews, creating projects, or uploading PDFs.
 *
 * Read endpoints DO NOT use this guard: guests can browse the cloned
 * template's drafts, citation audits, etc. freely.
 *
 * Usage:
 *   const user = await requireUser();
 *   const blocked = guestWriteBlock(user);
 *   if (blocked) return blocked;
 */
export function guestWriteBlock(user: { isGuest: boolean }): NextResponse | null {
  if (!user.isGuest) return null;
  return NextResponse.json(
    {
      error: "demo_mode_readonly",
      message:
        "Guest demo accounts can browse the sample data but can't create new reviews or modify content. Sign up for a real account to write.",
    },
    { status: 403 },
  );
}
