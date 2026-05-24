import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { guestWriteBlock } from "@/lib/demo/guards";
import { resolveCheckpoint } from "@/lib/agent/runs";
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

  // Atomic transition (PENDING -> REJECTED). A null return means another
  // concurrent caller already resolved this checkpoint; we MUST NOT call
  // resolveWaitToken with a fresh payload in that case — Trigger.dev's
  // wait.completeToken is not idempotent across different payloads. But
  // a null can also mean a prior attempt updated the DB row and then
  // crashed before completing the wait token — see F2 recovery below.
  const resolved = await resolveCheckpoint({
    checkpointId: cpId,
    status: "REJECTED",
    decisionPayload,
    rejectionReason: reason,
  });
  if (resolved === null) {
    // F2.2: Recovery path. If a prior attempt set status but failed to
    // deliver the wait token (Trigger outage between the DB update and
    // resolveWaitToken), the row will still have a non-null waitToken.
    // Replay using the persisted decisionPayload so the agent unblocks.
    const row = await db.humanCheckpoint.findUnique({
      where: { id: cpId },
      select: { waitToken: true, decisionPayload: true },
    });
    if (row?.waitToken) {
      await resolveWaitToken(
        row.waitToken,
        (row.decisionPayload ?? {}) as Record<string, unknown>,
      );
      await db.humanCheckpoint.update({
        where: { id: cpId },
        data: { waitToken: null },
      });
      return NextResponse.json({ ok: true, recovered: true });
    }
    return NextResponse.json({ error: "checkpoint_already_resolved" }, { status: 409 });
  }
  if (resolved.waitToken) {
    await resolveWaitToken(resolved.waitToken, decisionPayload);
    // F2.1: Null out the waitToken so a retry doesn't re-deliver it.
    // Safe to use update (not updateMany) — the row is guaranteed to
    // exist because resolveCheckpoint just updated it.
    await db.humanCheckpoint.update({
      where: { id: cpId },
      data: { waitToken: null },
    });
  }

  return NextResponse.json({ ok: true });
}
