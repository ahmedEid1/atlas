import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { createRun } from "@/lib/agent/runs";
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

  const run = await createRun({ projectId: id, question: project.question });
  await enqueueRunReview(run.id);

  return NextResponse.json({ runId: run.id }, { status: 201 });
}
