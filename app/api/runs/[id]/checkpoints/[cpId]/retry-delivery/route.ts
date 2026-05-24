import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { guestWriteBlock } from "@/lib/demo/guards";
import { deliverCheckpoint } from "@/lib/agent/checkpoint-delivery";

/**
 * Manual retry endpoint for stranded checkpoints — those where the user
 * approved or rejected (status != PENDING) but Phase 2 (Trigger.dev
 * wait-token delivery) failed, leaving waitToken set.
 *
 * Idempotent: calling on an already-delivered checkpoint returns
 * { ok: true, outcome: "already_delivered" }. Calling on a
 * still-pending checkpoint returns 409 — the normal approve/reject
 * flow should be used for that.
 *
 * The cron outbox at trigger/checkpoint-delivery-outbox.ts handles
 * automatic recovery every minute; this endpoint exists so the user
 * can trigger immediate retry from the run page without waiting.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; cpId: string }> },
) {
  const user = await requireUser().catch(() => null);
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const blocked = guestWriteBlock(user);
  if (blocked) return blocked;

  const { cpId } = await params;
  // Ownership check — same pattern as approve/reject.
  const cp = await db.humanCheckpoint.findUnique({
    where: { id: cpId },
    include: { run: { include: { project: { select: { ownerId: true } } } } },
  });
  if (!cp || cp.run.project.ownerId !== user.id) {
    return new NextResponse("Not found", { status: 404 });
  }

  // Only stranded checkpoints can be retried. Pending ones go through
  // approve/reject; null-waitToken ones are already delivered.
  if (cp.status === "PENDING") {
    return NextResponse.json(
      { error: "checkpoint_still_pending", message: "Use approve/reject for pending checkpoints." },
      { status: 409 },
    );
  }

  const result = await deliverCheckpoint(cpId);
  return NextResponse.json({ ok: true, outcome: result.outcome });
}
