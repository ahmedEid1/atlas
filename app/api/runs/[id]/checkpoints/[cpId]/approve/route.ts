import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { deliverCheckpoint } from "@/lib/agent/checkpoint-delivery";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; cpId: string }> },
) {
  const user = await requireUser().catch(() => null);
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { cpId } = await params;
  const cp = await db.humanCheckpoint.findUnique({
    where: { id: cpId },
    include: { run: { include: { project: { select: { ownerId: true } } } } },
  });
  if (!cp || cp.run.project.ownerId !== user.id) {
    return new NextResponse("Not found", { status: 404 });
  }

  // The checkpoint can only be actioned while the run is still waiting on it.
  // If the run already terminated — most commonly because the 24h HITL wait
  // token timed out and the worker failRun'd the run while the checkpoint row
  // stayed PENDING — committing the decision here would report success while
  // the (dead) graph never resumes. Reject with a clear signal instead.
  if (cp.run.status === "FAILED" || cp.run.status === "COMPLETED" || cp.run.status === "REJECTED") {
    return NextResponse.json(
      {
        error: "run_not_awaiting",
        message: "This run has already ended (it may have timed out after 24h) — the checkpoint can no longer be approved.",
      },
      { status: 409 },
    );
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
