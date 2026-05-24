import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: { project: { create: vi.fn(), findMany: vi.fn() } },
}));

import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { POST as projectsPOST } from "@/app/api/projects/route";

beforeEach(() => vi.clearAllMocks());

describe("Guest write-block on POST /api/projects", () => {
  it("returns 403 demo_mode_readonly when the caller is a guest", async () => {
    vi.mocked(requireUser).mockResolvedValue({
      id: "u_guest",
      isGuest: true,
    } as never);
    const req = new NextRequest("http://localhost/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "X", question: "Y?" }),
    });
    const res = await projectsPOST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("demo_mode_readonly");
    expect(db.project.create).not.toHaveBeenCalled();
  });

  it("still allows non-guest users to create projects", async () => {
    vi.mocked(requireUser).mockResolvedValue({
      id: "u_real",
      isGuest: false,
    } as never);
    vi.mocked(db.project.create).mockResolvedValue({
      id: "p1",
      ownerId: "u_real",
    } as never);
    const req = new NextRequest("http://localhost/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Real", question: "Real?" }),
    });
    const res = await projectsPOST(req);
    expect(res.status).toBe(201);
    expect(db.project.create).toHaveBeenCalled();
  });
});
