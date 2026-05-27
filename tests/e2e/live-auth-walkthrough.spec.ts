import { test, expect, type APIRequestContext } from "@playwright/test";
import { clerk, clerkSetup } from "@clerk/testing/playwright";
import dotenv from "dotenv";

/**
 * Real-user authenticated walkthrough against the deployed app.
 *
 * Flow:
 *   1. Sign in via the Clerk Backend API ticket strategy (using
 *      CLERK_SECRET_KEY + E2E_EMAIL from .env / .env.test).
 *   2. Navigate to /dashboard.
 *   3. Open the "New project" dialog, fill it, submit.
 *   4. Assert the new project page renders.
 *   5. **Clean up** — DELETE /api/projects/[id] (cascade-deletes corpus,
 *      runs, etc). Verify the dashboard no longer lists the project.
 *
 * What this does NOT do:
 *  - Click "Start review" or upload PDFs. Those would bill Mistral OCR +
 *    LLM tokens per CI run AND enqueue Trigger.dev background work that
 *    would still be running after the test exits. The MCP Inspector
 *    walkthrough in RELEASING.md covers that path manually.
 *
 * Gating: auto-skips when CLERK_SECRET_KEY or E2E_EMAIL aren't set on
 * the test runner (lets CI environments that don't have prod credentials
 * still run the rest of the live smoke).
 *
 * Run with:
 *   PLAYWRIGHT_BASE_URL=https://thoth-slr.vercel.app \
 *     pnpm playwright test tests/e2e/live-auth-walkthrough.spec.ts \
 *     --project=chromium
 */

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.test" });

const EMAIL = process.env.E2E_EMAIL ?? "";
const SECRET = process.env.CLERK_SECRET_KEY ?? "";

test.describe.configure({ mode: "serial" });

// The default 60s per-test timeout is too tight when serial-mode tests
// chain Neon-backed server renders against a Vercel deploy (cold-starts
// add 5-10s per project page render). 120s gives each authenticated
// test enough headroom without making failures slow to surface.
test.describe.configure({ timeout: 120_000 });

test.describe("live authenticated walkthrough", () => {
  test.beforeAll(async ({ playwright }, testInfo) => {
    if (!EMAIL || !SECRET) {
      testInfo.skip(
        true,
        "live-auth-walkthrough needs CLERK_SECRET_KEY + E2E_EMAIL in .env / .env.test",
      );
      return;
    }
    // clerkSetup pulls a Clerk testing-token + signing key the rest of the
    // spec uses. It's safe to call against ANY Clerk environment (dev or
    // prod) as long as CLERK_SECRET_KEY matches the publishable key the
    // target app boots with.
    await clerkSetup();

    // Defensive sweep: delete any orphan projects this test left on the
    // live deploy from a previous failed run (the in-test cleanup +
    // afterAll handle the happy + assertion-failure paths, but a hard
    // crash / killed process leaves rows behind). Match on the title
    // prefix the test uses below so we never touch a user's real data.
    const browser = await playwright.chromium.launch();
    try {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto("/");
      // Tests run in serial mode within one browser context, so the
    // Clerk session from the previous test persists. clerk.signIn
    // throws "You're already signed in" — that's fine, we want the
    // signed-in state. Treat that specific error as a pass-through.
    await clerk.signIn({ page, emailAddress: EMAIL }).catch((err: unknown) => {
      if (!/already signed in/i.test(String(err))) throw err;
    });
      const apiCtx: APIRequestContext = ctx.request;
      const list = await apiCtx.get("/api/projects");
      if (list.ok()) {
        const projects = (await list.json()) as Array<{ id: string; title: string }>;
        for (const p of projects) {
          if (p.title.startsWith("E2E live walkthrough")) {
            await apiCtx.delete(`/api/projects/${p.id}`);
            // 404 is fine — concurrent runs may race. 405 means the
            // DELETE endpoint isn't on the live deploy yet; we'll let
            // the in-test assertion surface that case loudly.
          }
        }
      }
    } finally {
      await browser.close();
    }
  });

  // Track every project this run creates so afterAll can DELETE them even
  // if a mid-test assertion fails. Belt + braces — the test itself also
  // deletes on the happy path.
  const createdProjectIds = new Set<string>();

  // afterAll cleanup — runs even when individual tests fail.
  test.afterAll(async ({ playwright }) => {
    if (createdProjectIds.size === 0) return;
    if (!EMAIL || !SECRET) return;

    // Build an authenticated request context: load the dashboard once in
    // a one-shot browser to capture the Clerk session cookie, then reuse
    // for the DELETE calls. Cheaper than spinning up a full browser per
    // project.
    const browser = await playwright.chromium.launch();
    try {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto("/");
      // Tests run in serial mode within one browser context, so the
    // Clerk session from the previous test persists. clerk.signIn
    // throws "You're already signed in" — that's fine, we want the
    // signed-in state. Treat that specific error as a pass-through.
    await clerk.signIn({ page, emailAddress: EMAIL }).catch((err: unknown) => {
      if (!/already signed in/i.test(String(err))) throw err;
    });
      await page.goto("/dashboard");
      await page.waitForLoadState("networkidle");

      const apiCtx: APIRequestContext = ctx.request;
      for (const id of createdProjectIds) {
        const res = await apiCtx.delete(`/api/projects/${id}`);
        // 204 = deleted, 404 = already gone (idempotent). Anything else
        // = the cleanup is leaking state on the live deploy — fail loud.
        if (res.status() !== 204 && res.status() !== 404) {
          throw new Error(
            `live-auth-walkthrough cleanup leaked project ${id}: status=${res.status()}`,
          );
        }
      }
    } finally {
      await browser.close();
    }
  });

  test("sign in, create a project, verify, then delete", async ({ page, context }) => {
    // 1. Sign in to the live deploy via the Clerk testing ticket.
    await page.goto("/");
    // Tests run in serial mode within one browser context, so the
    // Clerk session from the previous test persists. clerk.signIn
    // throws "You're already signed in" — that's fine, we want the
    // signed-in state. Treat that specific error as a pass-through.
    await clerk.signIn({ page, emailAddress: EMAIL }).catch((err: unknown) => {
      if (!/already signed in/i.test(String(err))) throw err;
    });
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    // 2. The dashboard's "New project" button should be present for a
    //    signed-in user.
    await expect(page.getByRole("button", { name: /new project/i })).toBeVisible({
      timeout: 15_000,
    });

    // 3. Open the dialog and create the project.
    await page.getByRole("button", { name: /new project/i }).click();
    const title = `E2E live walkthrough — ${new Date().toISOString()}`;
    await page.getByLabel(/title/i).fill(title);
    await page
      .getByLabel(/research question/i)
      .fill("What does Thoth's V2 outbound search support?");
    await page.getByRole("button", { name: /^create$/i }).click();

    // 4. Land on the new project page — the title is the H1.
    // 30s timeout because the project page is server-rendered against
    // Neon — a cold start adds 5-10s on top of the create POST + the
    // router.push transition. 15s was tight; 30s gives margin without
    // making the test slow.
    await expect(page.getByRole("heading", { name: title })).toBeVisible({ timeout: 30_000 });

    // Grab the project id out of the URL (`/projects/<id>`) so afterAll
    // cleanup can DELETE it if the rest of the test bails out.
    const url = page.url();
    const match = url.match(/\/projects\/([^/]+)/);
    expect(match, `project url did not match /projects/<id>: ${url}`).not.toBeNull();
    const projectId = match![1]!;
    createdProjectIds.add(projectId);

    // 5. Clean up while still signed in — DELETE the project + verify
    //    it disappears from the dashboard.
    const apiCtx = context.request;
    const del = await apiCtx.delete(`/api/projects/${projectId}`);
    expect(del.status()).toBe(204);
    createdProjectIds.delete(projectId);

    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");
    // The project title should no longer appear on the dashboard list.
    await expect(page.getByText(title)).toHaveCount(0);
  });

  // V2 outbound project shape — exercises the search-scope radio + provider
  // checkboxes in the create dialog + the Discovery configuration panel on
  // the project page. Does NOT click "Start review" (would bill LLM tokens
  // + enqueue Trigger.dev work + hit OpenAlex live).
  test("create an outbound v2 project, verify the discovery config panel, then delete", async ({ page, context }) => {
    // The v2 dialog grows tall once Outbound is picked (provider checkboxes
    // + search-tuning fieldset). Use a tall viewport so the Create button
    // stays in-view; the default 720px viewport pushes it below the fold
    // even with scrollIntoViewIfNeeded.
    await page.setViewportSize({ width: 1280, height: 1400 });
    await page.goto("/");
    // Tests run in serial mode within one browser context, so the
    // Clerk session from the previous test persists. clerk.signIn
    // throws "You're already signed in" — that's fine, we want the
    // signed-in state. Treat that specific error as a pass-through.
    await clerk.signIn({ page, emailAddress: EMAIL }).catch((err: unknown) => {
      if (!/already signed in/i.test(String(err))) throw err;
    });
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    // Open dialog → pick Outbound search → fill + create.
    await page.getByRole("button", { name: /new project/i }).click();
    const title = `E2E live walkthrough v2 — ${new Date().toISOString()}`;
    await page.getByLabel(/title/i).fill(title);
    await page
      .getByLabel(/research question/i)
      .fill("Does outbound search find papers Thoth's uploaded-only mode would miss?");

    // The "Outbound search" radio button + provider checkboxes are
    // hidden until visible — they're rendered inside the dialog from
    // the moment it opens. The default provider set is OpenAlex + arXiv.
    await page.getByRole("radio", { name: /outbound search/i }).check();

    // Verify the providers fieldset becomes visible with the defaults
    // pre-checked. Specifying providers redundantly is fine; the create
    // schema accepts the explicit list.
    await expect(page.getByText(/at least one is required/i)).toBeVisible();

    await page.getByRole("button", { name: /^create$/i }).click();

    // Land on the new project page → assert the v2 Discovery
    // configuration panel renders with the picked scope + providers.
    // 30s timeout because the project page is server-rendered against
    // Neon — a cold start adds 5-10s on top of the create POST + the
    // router.push transition. 15s was tight; 30s gives margin without
    // making the test slow.
    await expect(page.getByRole("heading", { name: title })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: /discovery configuration/i })).toBeVisible();
    // openalex + arxiv are listed in the provider row (M7 panel format).
    await expect(page.getByText(/openalex.*arxiv|arxiv.*openalex/i).first()).toBeVisible();
    // "Outbound search" appears as the Scope value.
    await expect(page.getByText(/^outbound search$/i)).toBeVisible();

    const url = page.url();
    const match = url.match(/\/projects\/([^/]+)/);
    expect(match, `project url did not match /projects/<id>: ${url}`).not.toBeNull();
    const projectId = match![1]!;
    createdProjectIds.add(projectId);

    // Clean up.
    const apiCtx = context.request;
    const del = await apiCtx.delete(`/api/projects/${projectId}`);
    expect(del.status()).toBe(204);
    createdProjectIds.delete(projectId);
  });

  // V2 hybrid scope + full search-tuning surface — exercises every
  // optional knob (year range, max hits, skip-discovery-gate) the
  // create dialog exposes and verifies they round-trip through the API
  // back into the project page's Discovery configuration panel.
  test("create a hybrid project with all tuning options, verify persistence, then delete", async ({ page, context }) => {
    await page.setViewportSize({ width: 1280, height: 1400 });
    await page.goto("/");
    // Tests run in serial mode within one browser context, so the
    // Clerk session from the previous test persists. clerk.signIn
    // throws "You're already signed in" — that's fine, we want the
    // signed-in state. Treat that specific error as a pass-through.
    await clerk.signIn({ page, emailAddress: EMAIL }).catch((err: unknown) => {
      if (!/already signed in/i.test(String(err))) throw err;
    });
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: /new project/i }).click();
    const title = `E2E live walkthrough hybrid — ${new Date().toISOString()}`;
    await page.getByLabel(/title/i).fill(title);
    await page
      .getByLabel(/research question/i)
      .fill("Does hybrid mode actually merge uploaded + outbound corpora?");

    await page.getByRole("radio", { name: /hybrid/i }).check();

    // Fill the search-tuning fieldset (visible only when scope != uploaded_only).
    await page.getByLabel(/from year/i).fill("2020");
    await page.getByLabel(/to year/i).fill("2025");
    await page.getByLabel(/max hits per run/i).fill("30");
    // The "Skip discovery approval" checkbox is labeled by its <label> wrapper.
    await page.getByRole("checkbox", { name: /skip discovery approval/i }).check();

    await page.getByRole("button", { name: /^create$/i }).click();
    // 30s timeout because the project page is server-rendered against
    // Neon — a cold start adds 5-10s on top of the create POST + the
    // router.push transition. 15s was tight; 30s gives margin without
    // making the test slow.
    await expect(page.getByRole("heading", { name: title })).toBeVisible({ timeout: 30_000 });

    // Verify the project-page Discovery configuration panel renders the
    // configured values. Scope label is "Hybrid (uploaded + outbound)".
    await expect(page.getByRole("heading", { name: /discovery configuration/i })).toBeVisible();
    await expect(page.getByText(/hybrid \(uploaded \+ outbound\)/i)).toBeVisible();
    // Max hits value rendered in the dl.
    await expect(page.getByText(/^30$/)).toBeVisible();
    // Year range row.
    await expect(page.getByText(/2020.*2025/)).toBeVisible();
    // skipDiscoveryGate row.
    await expect(page.getByText(/discovery approval skipped/i)).toBeVisible();

    const url = page.url();
    const projectId = url.match(/\/projects\/([^/]+)/)![1]!;
    createdProjectIds.add(projectId);

    // Round-trip check: hit GET /api/projects/[id] to confirm the
    // values landed in the DB (defends against a UI-only render that
    // doesn't actually persist).
    const apiCtx = context.request;
    const get = await apiCtx.get(`/api/projects/${projectId}`);
    expect(get.status()).toBe(200);
    const project = (await get.json()) as {
      searchScope: string;
      searchProviders: string[];
      searchYearStart: number | null;
      searchYearEnd: number | null;
      searchMaxHits: number;
      skipDiscoveryGate: boolean;
    };
    expect(project.searchScope).toBe("hybrid");
    expect(project.searchYearStart).toBe(2020);
    expect(project.searchYearEnd).toBe(2025);
    expect(project.searchMaxHits).toBe(30);
    expect(project.skipDiscoveryGate).toBe(true);
    // Hybrid auto-defaults providers to openalex + arxiv when not specified.
    expect(project.searchProviders.sort()).toEqual(["arxiv", "openalex"]);

    // Clean up.
    const del = await apiCtx.delete(`/api/projects/${projectId}`);
    expect(del.status()).toBe(204);
    createdProjectIds.delete(projectId);
  });

  // Authenticated 404 — the custom not-found.tsx renders a styled
  // page with three escape hatches (Back home / Open dashboard /
  // See a sample review). For unauthenticated visitors the proxy
  // middleware 307s to /sign-in (covered in live-browser-smoke.spec.ts);
  // for SIGNED-IN visitors hitting an unknown owned-resource path,
  // the route handler returns 404. Both paths preserve the
  // existence-probe defense: "doesn't exist" and "exists but unowned"
  // both return the same 404 (security-and-privacy.md §5).
  test("authenticated 404 page renders with the styled custom not-found", async ({ page }) => {
    await page.goto("/");
    // Tests run in serial mode within one browser context, so the
    // Clerk session from the previous test persists. clerk.signIn
    // throws "You're already signed in" — that's fine, we want the
    // signed-in state. Treat that specific error as a pass-through.
    await clerk.signIn({ page, emailAddress: EMAIL }).catch((err: unknown) => {
      if (!/already signed in/i.test(String(err))) throw err;
    });

    // Hit a project id that definitely doesn't exist + isn't owned by
    // this user. Same 404 either way.
    const response = await page.goto("/projects/does-not-exist-abc123");
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: /not found/i })).toBeVisible();
    // The "Back to home" CTA proves the styled custom 404 (not the default).
    await expect(page.getByRole("link", { name: /back to home/i })).toBeVisible();
  });

  // Real-user sign-out exercises the Clerk session-revoke + redirect
  // back to home. Verifies the auth UI flips back to the unauthenticated
  // state (Sign in button visible, no "New project" button).
  test("sign out clears the session + reveals the unauthenticated home", async ({ page }) => {
    await page.goto("/");
    // Tests run in serial mode within one browser context, so the
    // Clerk session from the previous test persists. clerk.signIn
    // throws "You're already signed in" — that's fine, we want the
    // signed-in state. Treat that specific error as a pass-through.
    await clerk.signIn({ page, emailAddress: EMAIL }).catch((err: unknown) => {
      if (!/already signed in/i.test(String(err))) throw err;
    });
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    // Sanity: signed-in state renders the New Project button.
    await expect(page.getByRole("button", { name: /new project/i })).toBeVisible({
      timeout: 15_000,
    });

    // Sign out via Clerk's testing helper (mirrors what the user-button
    // dropdown does internally). Hits clerk.signOut().
    await clerk.signOut({ page });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Public home: "Sign in" link visible, no signed-in CTAs.
    await expect(page.getByRole("link", { name: /sign in/i }).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole("button", { name: /new project/i })).toHaveCount(0);
  });
});
