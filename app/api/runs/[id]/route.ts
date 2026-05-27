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
