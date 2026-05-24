import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { createRun, setRunStatus } from "@/lib/agent/runs";
import { enqueueRunReview } from "@/lib/trigger-client";
import { guestWriteBlock } from "@/lib/demo/guards";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser().catch(() => null);
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const blocked = guestWriteBlock(user);
  if (blocked) return blocked;

  const { id } = await params;
  const project = await db.project.findUnique({ where: { id } });
  if (!project || project.ownerId !== user.id) {
    return new NextResponse("Not found", { status: 404 });
  }

  const corpusCount = await db.corpusItem.count({
    where: { projectId: id, status: "PARSED" },
  });
  if (corpusCount === 0) {
    return NextResponse.json(
      { error: "Project has no PARSED corpus items to review. Upload and parse at least one PDF first." },
      { status: 409 },
    );
  }

  const existingActive = await db.run.findFirst({
    where: {
      projectId: id,
      status: { notIn: ["COMPLETED", "REJECTED", "FAILED"] },
    },
    select: { id: true, status: true, createdAt: true },
  });
  if (existingActive) {
    return NextResponse.json(
      {
        error: "run_already_active",
        runId: existingActive.id,
        status: existingActive.status,
        message: `Run ${existingActive.id} is already ${existingActive.status.toLowerCase()}. Wait for it to finish (or fail) before starting a new one.`,
      },
      { status: 409 },
    );
  }

  const run = await createRun({ projectId: id, question: project.question });
  let triggerHandle: { id: string };
  try {
    triggerHandle = await enqueueRunReview(run.id);
  } catch (err) {
    // Trigger.dev is down or rejected the enqueue. Mark the run FAILED so it
    // isn't a permanent "orphan PENDING" blocking the active-run guard.
    await setRunStatus({
      runId: run.id,
      status: "FAILED",
    });
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[runs/POST] enqueueRunReview failed for run ${run.id}:`, err);
    return NextResponse.json(
      {
        error: "run_enqueue_failed",
        message: "Could not start the agent worker. Try again in a moment.",
        detail: msg.slice(0, 200),
      },
      { status: 502 },
    );
  }
  // Persist the handle so we can correlate the Run row with the Trigger run.
  await setRunStatus({
    runId: run.id,
    status: "PENDING",
    triggerRunId: triggerHandle.id,
  });
  return NextResponse.json({ runId: run.id, triggerRunId: triggerHandle.id }, { status: 201 });
}
