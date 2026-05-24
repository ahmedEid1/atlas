import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { guestWriteBlock } from "@/lib/demo/guards";
import { deliverCheckpoint } from "@/lib/agent/checkpoint-delivery";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; cpId: string }> },
) {
  const user = await requireUser().catch(() => null);
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const blocked = guestWriteBlock(user);
  if (blocked) return blocked;

  const { cpId } = await params;
  const cp = await db.humanCheckpoint.findUnique({
    where: { id: cpId },
    include: { run: { include: { project: { select: { ownerId: true } } } } },
  });
  if (!cp || cp.run.project.ownerId !== user.id) {
    return new NextResponse("Not found", { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const decisionPayload = { approved: true, ...body };

  // Round-4 fix: split the resolve into TWO consecutive transactions so an
  // external Trigger.dev failure cannot cause the persisted decision (and
  // therefore the audit log) to diverge from what was actually delivered
  // to the agent.
  //
  // Phase 1 — commit the decision (small, fast tx, no external call).
  // Once Phase 1 commits, the decision is IMMUTABLE: any later request
  // (approve OR reject) sees status != PENDING and writes nothing. This
  // is the critical invariant that prevents audit divergence. Phase 1
  // stays inline because the payload assembly is route-specific.
  const phase1 = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${cpId}))`;
    const updated = await tx.humanCheckpoint.updateMany({
      where: { id: cpId, status: "PENDING" },
      data: {
        status: "APPROVED",
        decisionPayload,
        decidedAt: new Date(),
      },
    });
    return { decided: updated.count > 0 };
  });

  // Phase 2 — deliver the persisted decision to Trigger.dev. Extracted
  // into the shared `deliverCheckpoint` helper so the same atomic
  // advisory-lock + findUnique + resolveWaitToken + null-out flow is
  // reused by the recovery-outbox cron (trigger/checkpoint-delivery-outbox).
  // The helper ALWAYS reads the persisted decisionPayload — it takes no
  // external payload param, which is the invariant that prevents an
  // audit-divergent retry from substituting its own decision.
  const phase2 = await deliverCheckpoint(cpId);

  if (phase2.outcome === "not_found") {
    return NextResponse.json(
      { error: "checkpoint_not_found" },
      { status: 404 },
    );
  }
  if (!phase1.decided && phase2.outcome === "already_delivered") {
    return NextResponse.json(
      { error: "checkpoint_already_resolved" },
      { status: 409 },
    );
  }
  if (!phase1.decided && phase2.outcome === "delivered") {
    return NextResponse.json({ ok: true, recovered: true });
  }
  return NextResponse.json({ ok: true });
}
