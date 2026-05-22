import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    project: { findUnique: vi.fn() },
    corpusItem: { create: vi.fn() },
  },
}));
vi.mock("@/lib/object-store", () => ({ putObject: vi.fn() }));
vi.mock("@/lib/trigger-client", () => ({ enqueueParsePdf: vi.fn() }));

import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { putObject } from "@/lib/object-store";
import { enqueueParsePdf } from "@/lib/trigger-client";

beforeEach(() => vi.clearAllMocks());

function buildPdfFormData(): FormData {
  const fd = new FormData();
  fd.set("projectId", "p1");
  fd.set(
    "file",
    new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "test.pdf", {
      type: "application/pdf",
    }),
  );
  return fd;
}

describe("POST /api/corpus/upload", () => {
  it("creates a PENDING corpus item, stores PDF, and enqueues parse task", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.project.findUnique).mockResolvedValue({ id: "p1", ownerId: "u1" } as never);
    vi.mocked(db.corpusItem.create).mockResolvedValue({ id: "c1" } as never);

    const { POST } = await import("@/app/api/corpus/upload/route");
    const req = new NextRequest("http://localhost/api/corpus/upload", {
      method: "POST",
      body: buildPdfFormData() as unknown as BodyInit,
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(putObject).toHaveBeenCalled();
    expect(db.corpusItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          projectId: "p1",
          kind: "PDF",
          status: "PENDING",
        }),
      }),
    );
    expect(enqueueParsePdf).toHaveBeenCalledWith("c1");
  });

  it("404s when the project does not belong to the user", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.project.findUnique).mockResolvedValue({ id: "p1", ownerId: "u2" } as never);

    const { POST } = await import("@/app/api/corpus/upload/route");
    const req = new NextRequest("http://localhost/api/corpus/upload", {
      method: "POST",
      body: buildPdfFormData() as unknown as BodyInit,
    });
    expect((await POST(req)).status).toBe(404);
  });

  it("rejects non-PDF mimetypes", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.project.findUnique).mockResolvedValue({ id: "p1", ownerId: "u1" } as never);

    const fd = new FormData();
    fd.set("projectId", "p1");
    fd.set("file", new File([new Uint8Array([1])], "x.txt", { type: "text/plain" }));

    const { POST } = await import("@/app/api/corpus/upload/route");
    const req = new NextRequest("http://localhost/api/corpus/upload", {
      method: "POST",
      body: fd as unknown as BodyInit,
    });
    expect((await POST(req)).status).toBe(415);
  });
});
