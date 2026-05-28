import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

/**
 * Delete a corpus item + cascade-delete its child rows.
 *
 * Cascade behaviour (from `prisma/schema.prisma`):
 *   - IncludedPaper rows referencing this item (onDelete: Cascade)
 *     → ExtractedClaim + ClaimCheck cascade with them
 *   - ScreeningDecision rows referencing this item (onDelete: SetNull)
 *     → the screening decision survives, just loses its corpusItem pointer
 *
 * So deleting a corpus item used in completed runs erases its
 * IncludedPaper rows in those runs — the run's published draft remains
 * but the cited-paper detail is gone. The UI confirm() is responsible
 * for warning the user.
 *
 * Existence-probe defense: 404 (not 403) for not-yours, matching the
 * rest of the API. Owner check is via the project FK.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser().catch(() => null);
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { id } = await params;
  const probe = await db.corpusItem.findUnique({
    where: { id },
    select: { project: { select: { ownerId: true } } },
  });
  if (!probe || probe.project.ownerId !== user.id) {
    return new NextResponse("Not found", { status: 404 });
  }
  await db.corpusItem.delete({ where: { id } });
  return new NextResponse(null, { status: 204 });
}
