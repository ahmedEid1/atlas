import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

/**
 * PATCH update schema — mirrors POST /api/projects's create schema
 * with every field optional. A bare `PATCH {}` is a no-op (returns
 * the unchanged row).
 *
 * Title + question reuse the same length bounds (≤120 / ≤2000); the
 * V2 fields reuse the same enums + ceilings as the create route.
 * Combined-refine for year-range ordering is unchanged.
 */
const updateSchema = z
  .object({
    title: z.string().min(1).max(120).optional(),
    question: z.string().min(1).max(2000).optional(),
    searchScope: z.enum(["uploaded_only", "outbound", "hybrid"]).optional(),
    searchProviders: z
      .array(z.enum(["openalex", "arxiv", "exa"]))
      .max(3)
      .optional(),
    searchYearStart: z.number().int().min(1900).max(2100).nullable().optional(),
    searchYearEnd: z.number().int().min(1900).max(2100).nullable().optional(),
    searchMaxHits: z.number().int().min(1).max(100).optional(),
    skipDiscoveryGate: z.boolean().optional(),
  })
  .refine(
    (data) =>
      !data.searchYearStart ||
      !data.searchYearEnd ||
      data.searchYearStart <= data.searchYearEnd,
    { message: "searchYearStart must be <= searchYearEnd" },
  );

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
 * Edit a project's settings. All fields optional; bare body = no-op.
 * Returns the updated row on success, 404 on unowned/missing (matching
 * the existence-probe pattern), 400 on validation error.
 *
 * Use this between runs to flip searchScope, switch providers, tune
 * max-hits, etc. The schema enforces the same bounds POST /api/projects
 * enforces at create time — a project can't be PATCHed into an invalid
 * shape that the create form wouldn't accept.
 *
 * Atomic owner check: `updateMany({ where: { id, ownerId } })` pushes
 * the ownership filter to the DB layer (matches the DELETE handler's
 * pattern) so concurrent edits + reads can't race.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser().catch(() => null);
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { id } = await params;
  const json = await req.json().catch(() => null);
  const parsed = updateSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  // If outbound/hybrid is being set + searchProviders not specified +
  // the row's current providers are empty, default to OpenAlex+arXiv
  // (same defaulting POST applies at create time). We only do this when
  // searchProviders isn't in the payload — letting the caller explicitly
  // pass [] to disable all providers (which the runs-start guard rejects).
  const data: typeof parsed.data = { ...parsed.data };
  if (
    (data.searchScope === "outbound" || data.searchScope === "hybrid") &&
    data.searchProviders === undefined
  ) {
    const existing = await db.project.findFirst({
      where: { id, ownerId: user.id },
      select: { searchProviders: true },
    });
    if (existing && existing.searchProviders.length === 0) {
      data.searchProviders = ["openalex", "arxiv"];
    }
  }

  const updated = await db.project.updateMany({
    where: { id, ownerId: user.id },
    data,
  });
  if (updated.count === 0) {
    return new NextResponse("Not found", { status: 404 });
  }

  // Re-fetch to return the canonical row — updateMany doesn't return
  // the updated rows.
  const fresh = await db.project.findUnique({ where: { id } });
  return NextResponse.json(fresh);
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
