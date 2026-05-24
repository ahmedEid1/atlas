import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/webhooks/clerk",
  "/api/demo/(.*)",  // sample-data entry point — anonymous, provisions guest Clerk user
  "/demo/handoff",   // client-side ticket consumption page (uses signIn.ticket() to activate the session)
  "/evals",          // public eval dashboard
  "/evals/(.*)",     // future per-question detail pages
  // MCP server has its own OAuth via withMcpAuth — must not be intercepted by
  // the browser-redirect middleware. Machine clients need 401 + WWW-Authenticate,
  // not a 307 to /sign-in. See app/api/mcp/[transport]/route.ts.
  "/api/mcp/(.*)",
  // OAuth Protected Resource Metadata + Authorization Server metadata are
  // by-spec publicly readable (RFC 9728 + RFC 8414).
  "/.well-known/oauth-protected-resource/(.*)",
  "/.well-known/oauth-authorization-server",
  // Liveness probe for self-host docker healthcheck + external monitors.
  // Must be reachable without auth so unhealthy containers are detected.
  "/api/health",
]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    // Redirect unauthenticated users to /sign-in instead of returning Clerk's
    // default 404. Better UX for anyone landing on a protected URL directly
    // (e.g. recruiters following a link to /dashboard).
    await auth.protect({ unauthenticatedUrl: new URL("/sign-in", req.url).toString() });
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/(.*)",
  ],
};
