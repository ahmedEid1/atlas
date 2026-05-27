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
      await clerk.signIn({ page, emailAddress: EMAIL });
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
      await clerk.signIn({ page, emailAddress: EMAIL });
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
    await clerk.signIn({ page, emailAddress: EMAIL });
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
    await expect(page.getByRole("heading", { name: title })).toBeVisible({ timeout: 15_000 });

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
    await clerk.signIn({ page, emailAddress: EMAIL });
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
    await expect(page.getByRole("heading", { name: title })).toBeVisible({ timeout: 15_000 });
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
});
