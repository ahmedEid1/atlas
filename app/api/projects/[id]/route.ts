import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser().catch(() => null);
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { id } = await params;
  const project = await db.project.findUnique({ where: { id } });
  if (!project || project.ownerId !== user.id) {
    return new NextResponse("Not found", { status: 404 });
  }
  return NextResponse.json(project);
}

/**
 * Delete a project + cascade-delete every owned row (CorpusItem rows,
 * Run rows, HumanCheckpoint, IncludedPaper, ExtractedClaim, ClaimCheck,
 * DiscoveredPaper, ScreeningDecision — all foreign keys point at
 * Project with onDelete: Cascade). Idempotent: 404 if the project
 * doesn't exist or isn't owned by the caller. The "not your record"
 * case is reported as 404 (not 403) to match the existence-probing
 * defense the rest of the API uses.
 *
 * Used by the dashboard's project delete affordance + the
 * live-auth-walkthrough e2e to clean up its created data.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser().catch(() => null);
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { id } = await params;
  // Atomic: read + delete in the same transaction so a concurrent rename
  // can't race the owner check. The `where: { id, ownerId }` form leverages
  // Prisma's composite filter so the delete itself enforces the owner check
  // at the DB layer (returns 0 rows affected when scope mismatches).
  const deleted = await db.project.deleteMany({
    where: { id, ownerId: user.id },
  });
  if (deleted.count === 0) {
    return new NextResponse("Not found", { status: 404 });
  }
  return new NextResponse(null, { status: 204 });
}
