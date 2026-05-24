import { createHash } from "node:crypto";
import { env } from "@/lib/env";

/**
 * Per-IP sliding-window rate limiter for the anonymous `/api/demo/start`
 * endpoint.
 *
 * Storage is process-local: a `Map<hashedIp, timestamps[]>` kept on
 * `globalThis` so Next.js HMR / module reloads in dev don't reset state
 * between requests. This is intentional and sufficient for the demo:
 *   - Vercel serverless: each invocation may hit a different lambda, so
 *     the effective limit is per-lambda. That's fine — it bounds the
 *     blast radius without paying for an external store, and an attacker
 *     would have to defeat lambda routing to bypass it.
 *   - Single-node deploys (Fly, Docker): the limit is global as expected.
 *
 * IPs are never stored raw. They're hashed via SHA-256 with a salt from
 * env (`IP_HASH_SALT`) so the in-memory map can't leak addresses.
 */

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_PER_WINDOW = 5;

type RateLimitStore = Map<string, number[]>;

// HMR-safe singleton. The `as unknown as { ... }` cast keeps TS happy
// without polluting the global type space.
const globalForRateLimit = globalThis as unknown as {
  __thothDemoRateLimit?: RateLimitStore;
};
globalForRateLimit.__thothDemoRateLimit ??= new Map<string, number[]>();
const store: RateLimitStore = globalForRateLimit.__thothDemoRateLimit;

/**
 * Extract a best-effort client IP from request headers. Order matches what
 * common deploy targets actually populate:
 *   - `x-vercel-forwarded-for`: Vercel-specific, most trustworthy on Vercel
 *   - `x-forwarded-for`: standard proxy header (take the first value —
 *      the rest are downstream proxies)
 *   - `x-real-ip`: nginx default
 * Returns `"unknown"` if none are present (still hashed — all "unknown"
 * callers share a bucket, which is a reasonable conservative default).
 */
export function extractClientIp(headers: Headers): string {
  const vercel = headers.get("x-vercel-forwarded-for");
  if (vercel) return vercel.split(",")[0]!.trim();

  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();

  const real = headers.get("x-real-ip");
  if (real) return real.trim();

  return "unknown";
}

function hashIp(ip: string): string {
  return createHash("sha256")
    .update(ip + env.IP_HASH_SALT)
    .digest("hex")
    .slice(0, 16);
}

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

/**
 * Sliding-window check: prunes entries older than the window, then either
 * records the new timestamp (allowed) or returns the seconds until the
 * oldest in-window entry expires (denied).
 *
 * NOTE: This records the call as soon as `allowed === true`. Callers
 * should call this BEFORE doing any side-effecting work — the contract
 * is "you may proceed; you've now consumed 1 of N attempts in this
 * window."
 */
export function checkRateLimit(ip: string): RateLimitResult {
  const key = hashIp(ip);
  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  const prior = store.get(key) ?? [];
  // Prune anything outside the window. Cheap because the cap (5) is tiny.
  const inWindow = prior.filter((t) => t > cutoff);

  if (inWindow.length >= MAX_PER_WINDOW) {
    const oldest = inWindow[0]!;
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
    // Persist the pruned array so memory doesn't grow unbounded for
    // hot keys that keep hammering the endpoint after being denied.
    store.set(key, inWindow);
    return { allowed: false, retryAfterSeconds };
  }

  inWindow.push(now);
  store.set(key, inWindow);
  return { allowed: true };
}

/** Test helper — wipes the limiter so suites stay isolated. */
export function _resetRateLimitForTest(): void {
  store.clear();
}
