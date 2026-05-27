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

  // Surface the deploy identifier so ops can correlate a health response
  // with a specific Vercel deployment. Vercel sets VERCEL_GIT_COMMIT_SHA on
  // every prod / preview build; locally it's undefined and the field is
  // omitted rather than emitted as null. This is the same pattern the
  // /evals page uses to render the "X of Y goldens at this commit" badge.
  const commitSha = process.env.VERCEL_GIT_COMMIT_SHA;

  return NextResponse.json(
    {
      ok,
      service: "thoth",
      dbReachable,
      ...(dbError && detailAllowed ? { dbError } : {}),
      ...(commitSha ? { commitSha: commitSha.slice(0, 7) } : {}),
      timestamp: new Date().toISOString(),
    },
    { status: ok ? 200 : 503 },
  );
}

export const runtime = "nodejs";
