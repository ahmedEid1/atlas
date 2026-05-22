import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { resolveCheckpoint } from "@/lib/agent/runs";
import { resolveWaitToken } from "@/lib/trigger-client";

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
  if (cp.status !== "PENDING") {
    return NextResponse.json({ error: "Checkpoint already resolved" }, { status: 409 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const decisionPayload = { approved: true, ...body };

  const resolved = await resolveCheckpoint({
    checkpointId: cpId,
    status: "APPROVED",
    decisionPayload,
  });
  if (resolved.waitToken) {
    await resolveWaitToken(resolved.waitToken, decisionPayload);
  }

  return NextResponse.json({ ok: true });
}
