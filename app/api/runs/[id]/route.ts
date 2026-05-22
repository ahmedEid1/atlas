import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser().catch(() => null);
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { id } = await params;
  const run = await db.run.findUnique({
    where: { id },
    include: {
      project: { select: { ownerId: true } },
      steps: { orderBy: { startedAt: "asc" } },
      checkpoints: { orderBy: { createdAt: "asc" } },
      includedPapers: true,
    },
  });
  if (!run || run.project.ownerId !== user.id) {
    return new NextResponse("Not found", { status: 404 });
  }
  return NextResponse.json(run);
}
