import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    project: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

beforeEach(() => vi.clearAllMocks());

describe("POST /api/projects", () => {
  it("creates a project for the current user", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.project.create).mockResolvedValue({
      id: "p1",
      title: "T",
      question: "Q",
      ownerId: "u1",
    } as never);

    const { POST } = await import("@/app/api/projects/route");
    const req = new NextRequest("http://localhost/api/projects", {
      method: "POST",
      body: JSON.stringify({ title: "T", question: "Q" }),
    });
    const res = await POST(req);

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("p1");
    expect(db.project.create).toHaveBeenCalledWith({
      data: { title: "T", question: "Q", ownerId: "u1" },
    });
  });

  it("rejects invalid body", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    const { POST } = await import("@/app/api/projects/route");
    const req = new NextRequest("http://localhost/api/projects", {
      method: "POST",
      body: JSON.stringify({ title: "" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  // V2 outbound configuration tests.
  it("accepts searchScope=outbound with explicit providers + year range + max-hits", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.project.create).mockResolvedValue({ id: "p2" } as never);

    const { POST } = await import("@/app/api/projects/route");
    const res = await POST(new NextRequest("http://localhost/api/projects", {
      method: "POST",
      body: JSON.stringify({
        title: "GAT review",
        question: "Q",
        searchScope: "outbound",
        searchProviders: ["openalex", "arxiv"],
        searchYearStart: 2018,
        searchYearEnd: 2025,
        searchMaxHits: 30,
      }),
    }));

    expect(res.status).toBe(201);
    expect(db.project.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        searchScope: "outbound",
        searchProviders: ["openalex", "arxiv"],
        searchYearStart: 2018,
        searchYearEnd: 2025,
        searchMaxHits: 30,
        ownerId: "u1",
      }),
    });
  });

  it("auto-defaults outbound-without-providers to ['openalex','arxiv']", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.project.create).mockResolvedValue({ id: "p3" } as never);

    const { POST } = await import("@/app/api/projects/route");
    await POST(new NextRequest("http://localhost/api/projects", {
      method: "POST",
      body: JSON.stringify({ title: "T", question: "Q", searchScope: "outbound" }),
    }));

    expect(db.project.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        searchScope: "outbound",
        searchProviders: ["openalex", "arxiv"],
      }),
    });
  });

  it("rejects searchYearStart > searchYearEnd", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);

    const { POST } = await import("@/app/api/projects/route");
    const res = await POST(new NextRequest("http://localhost/api/projects", {
      method: "POST",
      body: JSON.stringify({
        title: "T", question: "Q",
        searchYearStart: 2025, searchYearEnd: 2020,
      }),
    }));

    expect(res.status).toBe(400);
    expect(db.project.create).not.toHaveBeenCalled();
  });

  it("rejects searchMaxHits above the 100 hard ceiling", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);

    const { POST } = await import("@/app/api/projects/route");
    const res = await POST(new NextRequest("http://localhost/api/projects", {
      method: "POST",
      body: JSON.stringify({
        title: "T", question: "Q",
        searchScope: "outbound", searchMaxHits: 250,
      }),
    }));

    expect(res.status).toBe(400);
    expect(db.project.create).not.toHaveBeenCalled();
  });
});

describe("GET /api/projects/[id]", () => {
  it("returns 404 when project belongs to another user", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.project.findUnique).mockResolvedValue({
      id: "p1",
      ownerId: "u2",
    } as never);

    const { GET } = await import("@/app/api/projects/[id]/route");
    const res = await GET(new NextRequest("http://localhost/api/projects/p1"), {
      params: Promise.resolve({ id: "p1" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns the project when owned", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(db.project.findUnique).mockResolvedValue({
      id: "p1",
      ownerId: "u1",
      title: "T",
      question: "Q",
    } as never);

    const { GET } = await import("@/app/api/projects/[id]/route");
    const res = await GET(new NextRequest("http://localhost/api/projects/p1"), {
      params: Promise.resolve({ id: "p1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("p1");
  });
});
