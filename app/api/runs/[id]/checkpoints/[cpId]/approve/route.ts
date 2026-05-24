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

  // F2 + F3: All three operations (PENDING -> APPROVED transition, wait-token
  // probe, resolveWaitToken delivery, waitToken null-out) run inside a single
  // transaction holding a per-checkpoint advisory lock. This guarantees
  // exactly-once delivery of the Trigger.dev wait-token even under concurrent
  // retries: the lock serializes all approve/reject calls per checkpoint, so
  // the second caller sees the already-cleared waitToken and 409s instead of
  // double-delivering. The Trigger.dev HTTP call is held inside the tx
  // (timeout=30s accommodates typical Trigger latency); this is acceptable
  // because contention is per-checkpoint (one human approving one HITL pause).
  type ResolveResult =
    | { status: "delivered"; recovered: false }
    | { status: "delivered"; recovered: true }
    | { status: "already_resolved" };
  const result = await db.$transaction(
    async (tx): Promise<ResolveResult> => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${cpId}))`;
      const updated = await tx.humanCheckpoint.updateMany({
        where: { id: cpId, status: "PENDING" },
        data: {
          status: "APPROVED",
          decisionPayload,
          decidedAt: new Date(),
        },
      });
      const row = await tx.humanCheckpoint.findUnique({
        where: { id: cpId },
        select: { waitToken: true, decisionPayload: true },
      });
      if (updated.count === 1) {
        // Happy path: we won the race. Deliver with the LIVE request payload.
        if (row?.waitToken) {
          await resolveWaitToken(row.waitToken, decisionPayload);
          await tx.humanCheckpoint.update({
            where: { id: cpId },
            data: { waitToken: null },
          });
        }
        return { status: "delivered", recovered: false };
      }
      // updated.count === 0: a prior caller already transitioned the row.
      if (row?.waitToken) {
        // F2.2: Recovery — prior attempt crashed between DB update and
        // resolveWaitToken (Trigger outage). Replay with the PERSISTED
        // decisionPayload (NOT the current request body) so the agent
        // unblocks with the same decision the original caller recorded.
        await resolveWaitToken(
          row.waitToken,
          (row.decisionPayload ?? {}) as Record<string, unknown>,
        );
        await tx.humanCheckpoint.update({
          where: { id: cpId },
          data: { waitToken: null },
        });
        return { status: "delivered", recovered: true };
      }
      // Already resolved AND delivered — nothing to do.
      return { status: "already_resolved" };
    },
    { timeout: 30_000 },
  );

  if (result.status === "already_resolved") {
    return NextResponse.json(
      { error: "checkpoint_already_resolved" },
      { status: 409 },
    );
  }
  if (result.recovered) {
    return NextResponse.json({ ok: true, recovered: true });
  }
  return NextResponse.json({ ok: true });
}
