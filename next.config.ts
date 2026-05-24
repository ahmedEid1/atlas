import type { NextConfig } from "next";

/**
 * Baseline security headers. Scoped to non-API routes via
 * `source: "/((?!api/).*)"` so the MCP Streamable HTTP transport at
 * /api/mcp/[transport] — and every other /api/* route — is untouched.
 * X-Frame-Options / Referrer-Policy are HTML-document concerns; applying
 * them to JSON / streaming endpoints would be useless at best and risk
 * interfering with browser-side MCP clients at worst. HSTS is gated on
 * NODE_ENV=production so local http://localhost dev is not pinned.
 *
 * CSP is deliberately out of scope here — it is too easy to break the
 * app without per-route nonces and was excluded from this hardening pass.
 */
const securityHeaders: { key: string; value: string }[] = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

if (process.env.NODE_ENV === "production") {
  securityHeaders.push({
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  });
}

/**
 * Exclude /api/* (and the Next internals it implies) from the security
 * header set so we don't accidentally break the MCP Streamable HTTP
 * transport, webhooks, or other JSON/streaming endpoints.
 */
const NON_API_SOURCE = "/((?!api/).*)";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // app/evals/page.tsx calls `readdir("evals/golden")` at request time to
  // count the YAMLs vs how many produced rows in the latest sweep. That
  // readdir is dynamic, so Next.js's automatic file tracing doesn't see
  // the YAMLs as a dependency — without the explicit include below they
  // wouldn't ship into the Vercel function bundle, and the badge would
  // silently render 0/0 on prod.
  outputFileTracingIncludes: {
    "/evals": ["./evals/golden/**/*.yaml"],
  },
  async headers() {
    return [
      {
        source: NON_API_SOURCE,
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
