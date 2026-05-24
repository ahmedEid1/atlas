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
  // resolveWaitToken in that case — Trigger.dev's wait.completeToken is
  // not idempotent across different payloads.
  const resolved = await resolveCheckpoint({
    checkpointId: cpId,
    status: "REJECTED",
    decisionPayload,
    rejectionReason: reason,
  });
  if (resolved === null) {
    return NextResponse.json({ error: "checkpoint_already_resolved" }, { status: 409 });
  }
  if (resolved.waitToken) {
    await resolveWaitToken(resolved.waitToken, decisionPayload);
  }

  return NextResponse.json({ ok: true });
}
