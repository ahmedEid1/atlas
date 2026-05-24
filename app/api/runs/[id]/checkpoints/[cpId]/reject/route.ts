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

  const body = (await req.json().catch(() => ({}))) as { reason?: string };
  const reason = body.reason ?? "rejected";
  const decisionPayload = { approved: false, rejectionReason: reason };

  // Round-4 fix: see approve/route.ts for full rationale. Split into
  // Phase 1 (commit decision, no external call) + Phase 2 (deliver
  // persisted payload to Trigger.dev). The persisted decisionPayload is
  // immutable after Phase 1 commits, so an audit-divergent retry (e.g.
  // an APPROVE that committed Phase 1 then crashed during Phase 2,
  // followed by a REJECT retry) can never substitute its own payload —
  // Phase 2 always reads and re-delivers the original committed payload.
  // Phase 1 stays inline because the payload assembly is route-specific.
  const phase1 = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${cpId}))`;
    const updated = await tx.humanCheckpoint.updateMany({
      where: { id: cpId, status: "PENDING" },
      data: {
        status: "REJECTED",
        decisionPayload,
        rejectionReason: reason,
        decidedAt: new Date(),
      },
    });
    return { decided: updated.count > 0 };
  });

  // Phase 2 — delivery is handled by the shared helper, which also
  // backs the recovery-outbox cron. See lib/agent/checkpoint-delivery.ts.
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
