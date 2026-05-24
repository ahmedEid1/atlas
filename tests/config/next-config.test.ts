import { describe, it, expect, vi } from "vitest";

/**
 * Validates the baseline security posture declared in next.config.ts:
 *  - `poweredByHeader` is disabled.
 *  - The async `headers()` function returns the expected security header
 *    set on a source pattern that EXCLUDES /api/* (so the MCP Streamable
 *    HTTP transport at /api/mcp/[transport] is untouched).
 *  - HSTS is only emitted in production (NODE_ENV check).
 */

type HeaderRule = {
  source: string;
  headers: { key: string; value: string }[];
};

type LoadedConfig = {
  poweredByHeader?: boolean;
  headers?: () => Promise<HeaderRule[]>;
};

async function loadConfigWithNodeEnv(nodeEnv: string): Promise<{
  config: LoadedConfig;
  restore: () => void;
}> {
  const original = process.env.NODE_ENV;
  // NODE_ENV is typed as readonly; cast through Record to override in tests.
  (process.env as Record<string, string | undefined>).NODE_ENV = nodeEnv;
  // Re-evaluate the top-level `if (NODE_ENV === "production")` branch.
  vi.resetModules();
  const mod = (await import("@/next.config")) as { default: LoadedConfig };
  return {
    config: mod.default,
    restore: () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = original;
    },
  };
}

describe("next.config.ts", () => {
  it("disables the X-Powered-By header", async () => {
    const { config, restore } = await loadConfigWithNodeEnv("development");
    try {
      expect(config.poweredByHeader).toBe(false);
    } finally {
      restore();
    }
  });

  it("exposes an async headers() function returning at least one rule", async () => {
    const { config, restore } = await loadConfigWithNodeEnv("development");
    try {
      expect(typeof config.headers).toBe("function");
      const rules = await config.headers!();
      expect(Array.isArray(rules)).toBe(true);
      expect(rules.length).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });

  it("scopes security headers to a non-API source pattern", async () => {
    const { config, restore } = await loadConfigWithNodeEnv("development");
    try {
      const rules = await config.headers!();
      // Every rule must explicitly exclude /api so MCP transport + webhooks
      // are not affected.
      for (const rule of rules) {
        expect(rule.source).toMatch(/\(\?!api/);
        expect(rule.source).not.toBe("/(.*)");
      }
    } finally {
      restore();
    }
  });

  it("emits the baseline non-HSTS security headers in development", async () => {
    const { config, restore } = await loadConfigWithNodeEnv("development");
    try {
      const rules = await config.headers!();
      const headerMap = new Map(rules[0]!.headers.map((h) => [h.key, h.value]));

      expect(headerMap.get("X-Content-Type-Options")).toBe("nosniff");
      expect(headerMap.get("X-Frame-Options")).toBe("DENY");
      expect(headerMap.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
      expect(headerMap.get("Permissions-Policy")).toBe(
        "camera=(), microphone=(), geolocation=()",
      );
      // HSTS is production-gated.
      expect(headerMap.has("Strict-Transport-Security")).toBe(false);
    } finally {
      restore();
    }
  });

  it("emits HSTS only when NODE_ENV=production", async () => {
    const { config, restore } = await loadConfigWithNodeEnv("production");
    try {
      const rules = await config.headers!();
      const headerMap = new Map(rules[0]!.headers.map((h) => [h.key, h.value]));

      expect(headerMap.get("Strict-Transport-Security")).toBe(
        "max-age=63072000; includeSubDomains; preload",
      );
    } finally {
      restore();
    }
  });
});
