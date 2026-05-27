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

  // Mirror the catch-and-translate pattern from /api/projects/[id]/runs:
  // a Trigger.dev outage shouldn't propagate as a generic 500 — the client
  // can't distinguish that from any other server fault. 502 with a stable
  // error code lets the corpus-item-list surface a useful message.
  let handle: { id: string };
  try {
    handle = await enqueueSummarizePaper(id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[corpus/summarize] enqueueSummarizePaper failed for ${id}:`, err);
    return NextResponse.json(
      {
        error: "summarize_enqueue_failed",
        message: "Could not start the summary task. Try again in a moment.",
        detail: msg.slice(0, 200),
      },
      { status: 502 },
    );
  }
  return NextResponse.json({ runId: handle.id }, { status: 202 });
}
