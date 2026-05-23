import { PrismaNeon } from "@prisma/adapter-neon";
import { neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import { PrismaClient } from "@/app/generated/prisma/client";

// Neon's serverless driver opens a WebSocket to Postgres. Vercel's Node
// functions and Node 22+ have global WebSocket, but Trigger.dev's worker
// runtime doesn't expose one by default. Set the constructor explicitly so
// the driver works everywhere we run Atlas (Vercel, Trigger.dev, local).
neonConfig.webSocketConstructor = ws;

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

function createPrismaClient(): PrismaClient {
  // Read process.env at CREATE time (lazy via the proxy below), not at module load.
  const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

let _client: PrismaClient | null = null;
function getClient(): PrismaClient {
  if (_client) return _client;
  _client = globalForPrisma.prisma ?? createPrismaClient();
  if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = _client;
  return _client;
}

/**
 * Lazy Prisma client. The actual PrismaClient is constructed on first property
 * access, not at module import — same pattern as lib/env.ts. Lets build/index
 * tools load modules that import `db` without DATABASE_URL being set yet.
 *
 * Tests that mock `@/lib/db` (vi.mock) replace this export entirely, so the
 * proxy is bypassed in those cases.
 */
export const db = new Proxy({} as PrismaClient, {
  get(_, key) {
    const client = getClient();
    const value = (client as unknown as Record<string | symbol, unknown>)[key as string | symbol];
    if (typeof value === "function") return (value as (...a: unknown[]) => unknown).bind(client);
    return value;
  },
}) as PrismaClient;
