import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { enqueueSummarizePaper } from "@/lib/trigger-client";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser().catch(() => null);
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { id } = await params;
  const item = await db.corpusItem.findUnique({
    where: { id },
    include: { project: { select: { ownerId: true } } },
  });
  if (!item || item.project.ownerId !== user.id) {
    return new NextResponse("Not found", { status: 404 });
  }
  if (item.status !== "PARSED") {
    return NextResponse.json(
      { error: `Corpus item is ${item.status.toLowerCase()}, not yet PARSED` },
      { status: 409 },
    );
  }

  const run = await enqueueSummarizePaper(id);
  return NextResponse.json({ runId: run.id }, { status: 202 });
}
