import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Parametrized guest write-block coverage.
 *
 * Every POST mutation route in the app MUST call `guestWriteBlock(user)`
 * immediately after `requireUser()`. If a new mutation route is added
 * without that guard, a guest visitor can burn LLM/storage budget.
 *
 * To enforce this at the test-suite level: every POST mutation route
 * lives in the ROUTES array below. When you add a new mutation
 * endpoint, you MUST add it here. The test mocks requireUser to return
 * an isGuest=true user, invokes each POST, and asserts:
 *   - status === 403
 *   - body.error === "demo_mode_readonly"
 *   - no side-effect mock (db.*.create, enqueue*, putObject) was called
 *
 * If you intentionally need an unguarded mutation (rare), document why
 * and mark it with `skip: true` in the entry — the test will still fail
 * unless an explicit reason is recorded here.
 */

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    project: { create: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    corpusItem: { create: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
    humanCheckpoint: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/agent/runs", () => ({
  createRun: vi.fn(),
}));
vi.mock("@/lib/object-store", () => ({ putObject: vi.fn() }));
vi.mock("@/lib/trigger-client", () => ({
  enqueueRunReview: vi.fn(),
  enqueueParsePdf: vi.fn(),
  enqueueSummarizePaper: vi.fn(),
  resolveWaitToken: vi.fn(),
}));

import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { createRun } from "@/lib/agent/runs";
import { putObject } from "@/lib/object-store";
import {
  enqueueRunReview,
  enqueueParsePdf,
  enqueueSummarizePaper,
  resolveWaitToken,
} from "@/lib/trigger-client";

type RouteCase = {
  name: string;
  path: string;
  importPath: string;
  invoke: (
    POST: (req: NextRequest, ctx?: unknown) => Promise<Response>,
  ) => Promise<Response>;
};

function jsonBodyRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function uploadFormDataRequest(): NextRequest {
  const fd = new FormData();
  fd.set("projectId", "p1");
  fd.set(
    "file",
    new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "test.pdf", {
      type: "application/pdf",
    }),
  );
  return new NextRequest("http://localhost/api/corpus/upload", {
    method: "POST",
    body: fd as unknown as BodyInit,
  });
}

/**
 * CANONICAL list of guarded POST mutation routes. Keep in sync with the
 * filesystem; new entries are required for any route under app/api/**
 * that writes to the DB, enqueues a Trigger task, or calls a paid API.
 */
const ROUTES: RouteCase[] = [
  {
    name: "POST /api/projects",
    path: "app/api/projects/route.ts",
    importPath: "@/app/api/projects/route",
    invoke: (POST) =>
      POST(
        jsonBodyRequest("http://localhost/api/projects", {
          title: "X",
          question: "Y?",
        }),
      ),
  },
  {
    name: "POST /api/projects/[id]/runs",
    path: "app/api/projects/[id]/runs/route.ts",
    importPath: "@/app/api/projects/[id]/runs/route",
    invoke: (POST) =>
      POST(
        jsonBodyRequest("http://localhost/api/projects/p1/runs", {}),
        { params: Promise.resolve({ id: "p1" }) },
      ),
  },
  {
    name: "POST /api/corpus/upload",
    path: "app/api/corpus/upload/route.ts",
    importPath: "@/app/api/corpus/upload/route",
    invoke: (POST) => POST(uploadFormDataRequest()),
  },
  {
    name: "POST /api/corpus/[id]/summarize",
    path: "app/api/corpus/[id]/summarize/route.ts",
    importPath: "@/app/api/corpus/[id]/summarize/route",
    invoke: (POST) =>
      POST(
        jsonBodyRequest("http://localhost/api/corpus/c1/summarize", {}),
        { params: Promise.resolve({ id: "c1" }) },
      ),
  },
  {
    name: "POST /api/runs/[id]/checkpoints/[cpId]/approve",
    path: "app/api/runs/[id]/checkpoints/[cpId]/approve/route.ts",
    importPath: "@/app/api/runs/[id]/checkpoints/[cpId]/approve/route",
    invoke: (POST) =>
      POST(
        jsonBodyRequest(
          "http://localhost/api/runs/r1/checkpoints/cp1/approve",
          {},
        ),
        { params: Promise.resolve({ id: "r1", cpId: "cp1" }) },
      ),
  },
  {
    name: "POST /api/runs/[id]/checkpoints/[cpId]/reject",
    path: "app/api/runs/[id]/checkpoints/[cpId]/reject/route.ts",
    importPath: "@/app/api/runs/[id]/checkpoints/[cpId]/reject/route",
    invoke: (POST) =>
      POST(
        jsonBodyRequest(
          "http://localhost/api/runs/r1/checkpoints/cp1/reject",
          { reason: "x" },
        ),
        { params: Promise.resolve({ id: "r1", cpId: "cp1" }) },
      ),
  },
  {
    name: "POST /api/runs/[id]/checkpoints/[cpId]/retry-delivery",
    path: "app/api/runs/[id]/checkpoints/[cpId]/retry-delivery/route.ts",
    importPath: "@/app/api/runs/[id]/checkpoints/[cpId]/retry-delivery/route",
    invoke: (POST) =>
      POST(
        jsonBodyRequest(
          "http://localhost/api/runs/r1/checkpoints/cp1/retry-delivery",
          {},
        ),
        { params: Promise.resolve({ id: "r1", cpId: "cp1" }) },
      ),
  },
];

describe("Guest write-block coverage (every mutation POST must short-circuit before side effects)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireUser).mockResolvedValue({
      id: "u_guest",
      isGuest: true,
    } as never);
  });

  for (const route of ROUTES) {
    it(`${route.name} returns 403 demo_mode_readonly for guests and never touches paid side effects`, async () => {
      const mod = (await import(route.importPath)) as {
        POST: (req: NextRequest, ctx?: unknown) => Promise<Response>;
      };
      const res = await route.invoke(mod.POST);

      expect(res.status, `${route.name} should 403 for guests`).toBe(403);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("demo_mode_readonly");

      // No write or paid side effect may fire for a blocked guest.
      expect(db.project.create).not.toHaveBeenCalled();
      expect(db.corpusItem.create).not.toHaveBeenCalled();
      expect(createRun).not.toHaveBeenCalled();
      expect(putObject).not.toHaveBeenCalled();
      expect(enqueueRunReview).not.toHaveBeenCalled();
      expect(enqueueParsePdf).not.toHaveBeenCalled();
      expect(enqueueSummarizePaper).not.toHaveBeenCalled();
      expect(resolveWaitToken).not.toHaveBeenCalled();
    });
  }
});
