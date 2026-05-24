import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { guestWriteBlock } from "@/lib/demo/guards";
import { resolveWaitToken } from "@/lib/trigger-client";

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

  const phase2 = await db.$transaction(
    async (tx): Promise<{ outcome: "delivered" | "already_delivered" | "not_found" }> => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${cpId}))`;
      const row = await tx.humanCheckpoint.findUnique({
        where: { id: cpId },
        select: { waitToken: true, decisionPayload: true, status: true },
      });
      if (!row) {
        return { outcome: "not_found" };
      }
      if (!row.waitToken) {
        return { outcome: "already_delivered" };
      }
      await resolveWaitToken(
        row.waitToken,
        (row.decisionPayload ?? {}) as Record<string, unknown>,
      );
      await tx.humanCheckpoint.update({
        where: { id: cpId },
        data: { waitToken: null },
      });
      return { outcome: "delivered" };
    },
    { timeout: 30_000 },
  );

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
