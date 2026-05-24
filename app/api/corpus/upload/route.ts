import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { guestWriteBlock } from "@/lib/demo/guards";
import { putObject } from "@/lib/object-store";
import { enqueueParsePdf } from "@/lib/trigger-client";

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const blocked = guestWriteBlock(user);
  if (blocked) return blocked;

  const form = await req.formData();
  const projectId = form.get("projectId");
  const file = form.get("file");

  if (typeof projectId !== "string" || !(file instanceof File)) {
    return new NextResponse("Bad request", { status: 400 });
  }

  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project || project.ownerId !== user.id) {
    return new NextResponse("Not found", { status: 404 });
  }

  if (file.type !== "application/pdf") {
    return new NextResponse("Unsupported media type", { status: 415 });
  }
  if (file.size > MAX_BYTES) {
    return new NextResponse("Payload too large", { status: 413 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const key = `corpus/${projectId}/${randomUUID()}.pdf`;
  await putObject(key, bytes, "application/pdf");

  const item = await db.corpusItem.create({
    data: {
      projectId,
      kind: "PDF",
      status: "PENDING",
      source: key,
    },
  });

  // Best-effort: enqueue the parse job. If Trigger.dev is unavailable (e.g. in local dev
  // without the worker running, or with an invalid API key) the item stays PENDING and
  // can be retried later. We do NOT fail the upload because of an infra error.
  try {
    await enqueueParsePdf(item.id);
  } catch (err) {
    console.error("[upload] Failed to enqueue parse job:", err);
  }

  return NextResponse.json(item, { status: 201 });
}

export const runtime = "nodejs";
