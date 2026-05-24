import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { env } from "@/lib/env";

/**
 * Lightweight health probe used by self-host docker-compose and external monitors.
 * Reports app liveness + DB reachability. Public — no auth.
 *
 * Raw DB error text is sensitive (Prisma errors can include DB hostnames,
 * ports, and occasionally credentials) so it is OMITTED from the public
 * response by default. To opt in for debugging, set HEALTH_DETAIL_TOKEN
 * in the server env and send the same value in the `x-health-detail`
 * request header. The 200/503 status logic is unchanged either way; the
 * docker-compose healthcheck uses `wget --spider` and ignores the body.
 */
export async function GET(req: Request) {
  let dbReachable = false;
  let dbError: string | undefined;
  try {
    await db.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }
  const ok = dbReachable;

  const detailToken = env.HEALTH_DETAIL_TOKEN;
  const headerToken = req.headers.get("x-health-detail");
  const detailAllowed =
    typeof detailToken === "string" &&
    detailToken.length > 0 &&
    typeof headerToken === "string" &&
    headerToken.length > 0 &&
    headerToken === detailToken;

  return NextResponse.json(
    {
      ok,
      service: "thoth",
      dbReachable,
      ...(dbError && detailAllowed ? { dbError } : {}),
      timestamp: new Date().toISOString(),
    },
    { status: ok ? 200 : 503 },
  );
}

export const runtime = "nodejs";
