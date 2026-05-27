import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { createRun, setRunStatus } from "@/lib/agent/runs";
import { enqueueRunReview } from "@/lib/trigger-client";
import { env } from "@/lib/env";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser().catch(() => null);
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { id } = await params;
  const project = await db.project.findUnique({ where: { id } });
  if (!project || project.ownerId !== user.id) {
    return new NextResponse("Not found", { status: 404 });
  }

  // V2: outbound runs discover their own corpus via the search providers;
  // they don't need uploaded PDFs. uploaded_only + hybrid still require at
  // least one PARSED upload because the V1 retriever runs against uploaded
  // items first, and a hybrid run with zero uploads is just an outbound run.
  if (project.searchScope === "uploaded_only" || project.searchScope === "hybrid") {
    const corpusCount = await db.corpusItem.count({
      where: { projectId: id, status: "PARSED" },
    });
    if (corpusCount === 0) {
      return NextResponse.json(
        {
          error:
            project.searchScope === "uploaded_only"
              ? "Project has no PARSED corpus items to review. Upload and parse at least one PDF first."
              : "Hybrid mode needs at least one PARSED corpus item. Upload a PDF or switch the project's search scope to 'outbound'.",
        },
        { status: 409 },
      );
    }
  }
  if (project.searchScope === "outbound" || project.searchScope === "hybrid") {
    if (project.searchProviders.length === 0) {
      return NextResponse.json(
        {
          error:
            "Outbound mode requires at least one search provider (OpenAlex / arXiv / Exa). Edit the project's search providers and try again.",
        },
        { status: 409 },
      );
    }
    // Fail fast when the operator kill-switch is set: without this, the
    // planner would run + bill ~2k LLM tokens, the plan_gate would
    // interrupt + bill HITL latency, and the discoverer would only THEN
    // throw with the SEARCH_DISABLED message — by which point the user
    // has paid for half a planning round. 503 here keeps the failure mode
    // crisp and matches the discoverer's runtime check.
    if (env.SEARCH_DISABLED === "1") {
      return NextResponse.json(
        {
          error: "search_disabled",
          message:
            "Outbound search is temporarily disabled on this deploy (operator kill-switch). Try again later, or switch the project to uploaded-only.",
        },
        { status: 503 },
      );
    }
  }

  // F1: Active-run guard MUST be inside a transaction holding a per-project
  // advisory lock — otherwise two concurrent POSTs both see a clean
  // findFirst (neither sees the other's not-yet-committed Run) and both
  // create runs + enqueue Trigger jobs, doubling LLM spend on a double-click.
  // pg_advisory_xact_lock(hashtext($1)) serializes all run-creation attempts
  // per project; the lock auto-releases at COMMIT/ROLLBACK. Trigger.dev calls
  // happen AFTER the tx commits — they can take seconds and must not hold
  // either the DB transaction or the advisory lock.
  type GuardResult =
    | { conflict: { id: string; status: string } }
    | { run: { id: string } };
  const guardResult = await db.$transaction(async (tx): Promise<GuardResult> => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
    const existingActive = await tx.run.findFirst({
      where: {
        projectId: id,
        status: { notIn: ["COMPLETED", "REJECTED", "FAILED"] },
      },
      select: { id: true, status: true },
    });
    if (existingActive) {
      return { conflict: existingActive };
    }
    const created = await createRun({ projectId: id, question: project.question }, tx);
    return { run: created };
  });
  if ("conflict" in guardResult) {
    const existingActive = guardResult.conflict;
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
  const run = guardResult.run;
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
