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
  // is the critical invariant that prevents audit divergence.
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

  // Phase 2 — deliver the persisted decision to Trigger.dev.
  // ALWAYS uses the persisted decisionPayload (never the live request
  // body). If Phase 2 fails after Trigger succeeds, the tx rolls back,
  // waitToken stays set, and a retry replays delivery with the SAME
  // persisted payload — so the agent and the DB stay in lockstep.
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
      // Always use the PERSISTED payload — the first caller's committed
      // decision is what the agent must see; later retries cannot
      // substitute their own payload.
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
