import { Langfuse } from "langfuse";
import { env } from "@/lib/env";

let _client: Langfuse | null = null;

/**
 * Lazy Langfuse client. Constructed on first call to avoid loading env at module-eval
 * time (which would break Vitest's process.env mocks).
 */
export function getLangfuse(): Langfuse {
  if (_client) return _client;
  _client = new Langfuse({
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY,
    baseUrl: env.LANGFUSE_HOST,
    flushAt: 1, // flush every event immediately in dev; override via env for prod batching
  });
  return _client;
}

/** For tests: reset the cached client so a fresh one is built on next getLangfuse(). */
export function _resetLangfuseForTest(): void {
  _client = null;
}
