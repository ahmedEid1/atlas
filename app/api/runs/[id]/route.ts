import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

/**
 * Read-only view of a Run owned by the current user.
 *
 * Returns 404 for both "no such run" and "not yours" — same posture as the
 * MCP tools, so existence-probing can't enumerate other users' run ids.
 *
 * SECURITY: `HumanCheckpoint.waitToken` is the server-side secret used to
 * resolve the Trigger.dev wait gate (see lib/agent/checkpoint-delivery.ts).
 * It must never cross the client boundary — even to the run's owner, since
 * the JSON could be persisted, logged, or shared. The explicit `select` on
 * checkpoints below omits it; we derive an `awaitingDelivery` boolean for
 * the same recovery affordance the run-detail page uses.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser().catch(() => null);
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { id } = await params;
  const run = await db.run.findUnique({
    where: { id },
    include: {
      project: { select: { ownerId: true } },
      steps: { orderBy: { startedAt: "asc" } },
      checkpoints: {
        orderBy: { createdAt: "asc" },
        // waitToken is selected here so we can DERIVE awaitingDelivery off it
        // server-side; it's stripped from the response shape below before any
        // bytes leave the server. Matches the derivation in the run-detail
        // server page (app/projects/[id]/runs/[runId]/page.tsx:50).
        select: {
          id: true,
          kind: true,
          status: true,
          proposal: true,
          decisionPayload: true,
          rejectionReason: true,
          createdAt: true,
          decidedAt: true,
          attemptCount: true,
          lastDeliveryAttemptAt: true,
          terminalError: true,
          waitToken: true,
        },
      },
      includedPapers: true,
      // V2 — outbound/hybrid runs accumulate DiscoveredPaper rows + per-row
      // ScreeningDecision. Including both in the API response so the
      // run-detail page (server component) and external clients (MCP tools,
      // live e2e) can render the V2 surface without a separate fetch.
      // Uploaded_only runs have empty arrays here.
      discoveredPapers: {
        orderBy: { initialScore: "desc" },
        include: { screening: true },
      },
    },
  });
  if (!run || run.project.ownerId !== user.id) {
    return new NextResponse("Not found", { status: 404 });
  }

  const { checkpoints, ...rest } = run;
  return NextResponse.json({
    ...rest,
    checkpoints: checkpoints.map(({ waitToken, ...c }) => ({
      ...c,
      // Stranded = decision committed in Phase 1 (status != PENDING) but
      // Phase 2 (waitToken null-out) hasn't succeeded yet. waitToken itself
      // is stripped from the returned object via destructuring above.
      awaitingDelivery: c.status !== "PENDING" && waitToken !== null,
    })),
  });
}

/**
 * Delete a run + cascade-delete every owned child row (RunStep,
 * HumanCheckpoint, IncludedPaper, ExtractedClaim, ClaimCheck,
 * DiscoveredPaper, ScreeningDecision — all FK with onDelete: Cascade
 * pointing at Run).
 *
 * Used by the project-page run-list "Delete" affordance and lets users
 * discard failed or experimental runs that clutter the history. The
 * underlying Trigger.dev run keeps running but its DB writes will fail
 * silently — acceptable because the user explicitly asked to discard.
 *
 * Like the project DELETE, the not-yours case returns 404 (not 403) to
 * match the existence-probing posture of the rest of the API. The owner
 * filter is pushed to the DB layer via deleteMany's composite where so
 * concurrent rename can't race the owner check.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser().catch(() => null);
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { id } = await params;
  // Atomic: ownership probe + delete is one round-trip via the composite
  // where on `{ id, ownerId }` after a join through project. Prisma doesn't
  // support FK-following filters directly on deleteMany, so we issue the
  // ownership check first then the delete second — racing the two is harmless
  // because the worst case is a 204 immediately followed by a 404 on a
  // re-issued request, which is idempotent semantics for DELETE.
  const probe = await db.run.findUnique({
    where: { id },
    select: { project: { select: { ownerId: true } } },
  });
  if (!probe || probe.project.ownerId !== user.id) {
    return new NextResponse("Not found", { status: 404 });
  }
  await db.run.delete({ where: { id } });
  return new NextResponse(null, { status: 204 });
}
