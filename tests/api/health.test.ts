import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: vi.fn(),
  },
}));

// Mutable env mock so each test can flip HEALTH_DETAIL_TOKEN.
const envMock: { HEALTH_DETAIL_TOKEN?: string } = {};
vi.mock("@/lib/env", () => ({ env: envMock }));

import { db } from "@/lib/db";

beforeEach(() => {
  vi.clearAllMocks();
  delete envMock.HEALTH_DETAIL_TOKEN;
});

type HealthBody = {
  ok: boolean;
  service: string;
  dbReachable: boolean;
  dbError?: string;
  timestamp: string;
};

describe("GET /api/health", () => {
  it("returns 200 + ok:true when the DB is reachable", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue([{ "?column?": 1 }] as never);

    const { GET } = await import("@/app/api/health/route");
    const res = await GET(new Request("http://localhost/api/health"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthBody;
    expect(body.ok).toBe(true);
    expect(body.dbReachable).toBe(true);
    expect(body.service).toBe("thoth");
    expect(body.dbError).toBeUndefined();
    expect(typeof body.timestamp).toBe("string");
  });

  it("returns 503 + ok:false and OMITS dbError by default when the DB query rejects", async () => {
    vi.mocked(db.$queryRaw).mockRejectedValue(new Error("connection refused to db.internal:5432"));

    const { GET } = await import("@/app/api/health/route");
    const res = await GET(new Request("http://localhost/api/health"));

    expect(res.status).toBe(503);
    const body = (await res.json()) as HealthBody;
    expect(body.ok).toBe(false);
    expect(body.dbReachable).toBe(false);
    // Sensitive raw error must not leak by default.
    expect(body.dbError).toBeUndefined();
  });

  it("INCLUDES dbError when both env token and request header match", async () => {
    envMock.HEALTH_DETAIL_TOKEN = "secret";
    vi.mocked(db.$queryRaw).mockRejectedValue(new Error("connection refused"));

    const { GET } = await import("@/app/api/health/route");
    const res = await GET(
      new Request("http://localhost/api/health", {
        headers: { "x-health-detail": "secret" },
      }),
    );

    expect(res.status).toBe(503);
    const body = (await res.json()) as HealthBody;
    expect(body.dbError).toBe("connection refused");
  });

  it("OMITS dbError when env token is unset even if the header is present", async () => {
    // HEALTH_DETAIL_TOKEN deliberately unset.
    vi.mocked(db.$queryRaw).mockRejectedValue(new Error("connection refused"));

    const { GET } = await import("@/app/api/health/route");
    const res = await GET(
      new Request("http://localhost/api/health", {
        headers: { "x-health-detail": "anything" },
      }),
    );

    expect(res.status).toBe(503);
    const body = (await res.json()) as HealthBody;
    expect(body.dbError).toBeUndefined();
  });

  it("OMITS dbError when env token is set but the request header does not match", async () => {
    envMock.HEALTH_DETAIL_TOKEN = "secret";
    vi.mocked(db.$queryRaw).mockRejectedValue(new Error("connection refused"));

    const { GET } = await import("@/app/api/health/route");
    const res = await GET(
      new Request("http://localhost/api/health", {
        headers: { "x-health-detail": "wrong" },
      }),
    );

    expect(res.status).toBe(503);
    const body = (await res.json()) as HealthBody;
    expect(body.dbError).toBeUndefined();
  });
});
