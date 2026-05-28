import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: { run: { findUnique: vi.fn() } },
}));

import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/runs/[id]/draft.md", () => {
  it("returns the draft as a markdown attachment for the owner", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.run.findUnique).mockResolvedValue({
      draft: "# My Review\n\nClaim [paper_001].",
      createdAt: new Date("2026-05-28T14:00:00Z"),
      completedAt: new Date("2026-05-28T14:15:30Z"),
      question: "How does archaeal hibernation work?",
      project: { ownerId: "u1", title: "GAT Review" },
    } as never);

    const { GET } = await import("@/app/api/runs/[id]/draft.md/route");
    const res = await GET(
      new NextRequest("http://localhost/api/runs/r1/draft.md"),
      { params: Promise.resolve({ id: "r1" }) },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    // M66: human-readable filename — slugified project title + run date.
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="thoth-gat-review-2026-05-28.md"',
    );
    // Cache-Control: no-store so a re-run's new draft isn't masked by a
    // cached old download.
    expect(res.headers.get("cache-control")).toBe("no-store");
    // M76: HTML-comment provenance header prepended; the original
    // draft body is preserved verbatim afterwards.
    const text = await res.text();
    expect(text).toContain("<!--");
    expect(text).toContain("Thoth review draft");
    expect(text).toContain("Project: GAT Review");
    expect(text).toContain("Question: How does archaeal hibernation work?");
    expect(text).toContain("Run started: 2026-05-28T14:00:00.000Z");
    expect(text).toContain("Run completed: 2026-05-28T14:15:30.000Z");
    expect(text).toContain("-->");
    expect(text.endsWith("# My Review\n\nClaim [paper_001].")).toBe(true);
  });

  it("returns 404 when the run has no draft yet (in-flight or rejected)", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.run.findUnique).mockResolvedValue({
      draft: null,
      project: { ownerId: "u1" },
    } as never);

    const { GET } = await import("@/app/api/runs/[id]/draft.md/route");
    const res = await GET(
      new NextRequest("http://localhost/api/runs/r1/draft.md"),
      { params: Promise.resolve({ id: "r1" }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 for runs the caller doesn't own (existence-probe defense)", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.run.findUnique).mockResolvedValue({
      draft: "# Someone else's review",
      project: { ownerId: "u2" },
    } as never);

    const { GET } = await import("@/app/api/runs/[id]/draft.md/route");
    const res = await GET(
      new NextRequest("http://localhost/api/runs/r1/draft.md"),
      { params: Promise.resolve({ id: "r1" }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error("unauth"));

    const { GET } = await import("@/app/api/runs/[id]/draft.md/route");
    const res = await GET(
      new NextRequest("http://localhost/api/runs/r1/draft.md"),
      { params: Promise.resolve({ id: "r1" }) },
    );
    expect(res.status).toBe(401);
    expect(db.run.findUnique).not.toHaveBeenCalled();
  });
});
