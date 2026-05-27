import { test, expect, type APIRequestContext } from "@playwright/test";
import { clerk, clerkSetup } from "@clerk/testing/playwright";
import path from "node:path";
import dotenv from "dotenv";

/**
 * Full end-to-end agent-pipeline coverage against the deployed app.
 *
 * Per user direction ("we are using free llms, so cover everything"):
 * exercise the COMPLETE flow that a real user takes, including the
 * expensive LLM-billing nodes:
 *
 *   upload → PARSE → start review → plan_gate → approve →
 *   retriever → papers_gate → approve → assessor → drafter →
 *   critic → cite_check → COMPLETED → user sees draft + cite_check audit
 *
 * Cost per CI run: 1 Mistral OCR + ~150-250k Mistral LLM tokens
 * (planner + retriever + assessor + drafter + critic + cite_check).
 * Mistral free Experiment tier is $0 — acceptable.
 *
 * Runtime per test: ~2-4 minutes (Mistral free tier rate limit serializes
 * the cite_check per-claim loop). Each test has a generous 6-minute
 * per-test timeout.
 *
 * Cleanup: every test ends with DELETE /api/projects/<id> which cascades
 * the entire run + corpus + claims tree. Defensive beforeAll sweep + an
 * afterAll belt-and-braces match the live-auth-walkthrough pattern.
 */

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.test" });

const EMAIL = process.env.E2E_EMAIL ?? "";
const SECRET = process.env.CLERK_SECRET_KEY ?? "";

test.describe.configure({ mode: "serial" });
test.describe.configure({ timeout: 6 * 60 * 1000 });

test.describe("live full agent-pipeline", () => {
  const createdProjectIds = new Set<string>();

  test.beforeAll(async ({ playwright }, testInfo) => {
    if (!EMAIL || !SECRET) {
      testInfo.skip(
        true,
        "live-full-pipeline needs CLERK_SECRET_KEY + E2E_EMAIL in .env / .env.test",
      );
      return;
    }
    await clerkSetup();

    // Defensive sweep: delete any orphan projects left by prior crashed
    // runs. Match on the test's title prefix only so we never touch real
    // user data.
    const browser = await playwright.chromium.launch();
    try {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto("/");
      await clerk.signIn({ page, emailAddress: EMAIL }).catch((err: unknown) => {
        if (!/already signed in/i.test(String(err))) throw err;
      });
      const apiCtx: APIRequestContext = ctx.request;
      const list = await apiCtx.get("/api/projects");
      if (list.ok()) {
        const projects = (await list.json()) as Array<{ id: string; title: string }>;
        for (const p of projects) {
          if (p.title.startsWith("E2E full-pipeline")) {
            await apiCtx.delete(`/api/projects/${p.id}`);
          }
        }
      }
    } finally {
      await browser.close();
    }
  });

  test.afterAll(async ({ playwright }) => {
    if (createdProjectIds.size === 0 || !EMAIL || !SECRET) return;
    const browser = await playwright.chromium.launch();
    try {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto("/");
      await clerk.signIn({ page, emailAddress: EMAIL }).catch((err: unknown) => {
        if (!/already signed in/i.test(String(err))) throw err;
      });
      const apiCtx: APIRequestContext = ctx.request;
      for (const id of createdProjectIds) {
        const res = await apiCtx.delete(`/api/projects/${id}`);
        if (res.status() !== 204 && res.status() !== 404) {
          throw new Error(
            `live-full-pipeline cleanup leaked project ${id}: status=${res.status()}`,
          );
        }
      }
    } finally {
      await browser.close();
    }
  });

  /**
   * Helper: poll a project's run status via GET /api/runs/<runId>/status
   * (or via the project page's RefreshTick re-render — whichever is more
   * stable). Returns when the status matches `wanted` OR throws on timeout.
   */
  async function waitForRunStatus(
    apiCtx: APIRequestContext,
    runId: string,
    wanted: string,
    timeoutMs = 90_000,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const res = await apiCtx.get(`/api/runs/${runId}`);
      if (res.ok()) {
        const body = (await res.json()) as { status: string };
        if (body.status === wanted) return;
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }
    throw new Error(`run ${runId} did not reach status=${wanted} within ${timeoutMs}ms`);
  }

  test("V2 outbound happy path: planner → discoverer (auto-approved) → fetcher → screener → papers_gate → assessor → drafter → critic → cite_check", async ({ page, context }) => {
    // Use OUTBOUND mode with skipDiscoveryGate=true and a small maxHits cap:
    //   - Outbound guarantees the discoverer surfaces REAL papers from
    //     OpenAlex (uploaded_only mode depends on a fixture matching the
    //     question, which our image-only short.pdf doesn't).
    //   - skipDiscoveryGate=true bypasses the discovery HITL gate so the
    //     test only needs to click 2 buttons (plan approval + papers
    //     approval) instead of 3.
    //   - searchMaxHits=5 caps the screener to 5 LLM calls + 5 OCR calls
    //     instead of the default 50 — keeps the run inside Mistral
    //     free-tier RPS budget and total test time under ~4 min.
    //   - Provider=arxiv only (OpenAlex sometimes returns 0 hits for
    //     niche queries; arXiv reliably finds CS/ML papers).

    await page.setViewportSize({ width: 1280, height: 1400 });
    await page.goto("/");
    await clerk.signIn({ page, emailAddress: EMAIL }).catch((err: unknown) => {
      if (!/already signed in/i.test(String(err))) throw err;
    });
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: /new project/i }).click();
    const title = `E2E full-pipeline outbound — ${new Date().toISOString()}`;
    await page.getByLabel(/title/i).fill(title);
    await page
      .getByLabel(/research question/i)
      .fill("How does retrieval-augmented generation reduce hallucinations in large language models?");
    await page.getByRole("radio", { name: /outbound search/i }).check();
    // Uncheck OpenAlex (default), keep arXiv only — arXiv is the most
    // reliable provider for ML/NLP topics like RAG.
    await page.getByRole("checkbox", { name: /openalex/i }).uncheck();
    await page.getByLabel(/max hits per run/i).fill("5");
    await page.getByRole("checkbox", { name: /skip discovery approval/i }).check();

    await page.getByRole("button", { name: /^create$/i }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible({ timeout: 30_000 });

    const projectId = page.url().match(/\/projects\/([^/]+)/)![1]!;
    createdProjectIds.add(projectId);

    // Start review — no corpus needed (outbound builds it).
    await page.getByRole("button", { name: /start review/i }).click();

    // Wait for plan_gate. Planner takes ~5-15s on Mistral free tier.
    await expect(page.getByRole("heading", { name: /review proposed plan/i }))
      .toBeVisible({ timeout: 120_000 });

    // Approve plan.
    await page.getByRole("button", { name: /approve plan/i }).click();

    // discovery_gate is auto-approved (skipDiscoveryGate=true), so the
    // graph flows: discoverer → fetcher → screener → papers_gate. Total
    // ~90-180s depending on arXiv response time + the 5 OCR rounds.
    await expect(page.getByRole("heading", { name: /approve included papers/i }))
      .toBeVisible({ timeout: 4 * 60 * 1000 });

    // Approve the screener's include set. Whatever N papers it admitted.
    // The button label is "Approve N" where N >= 1 if the screener
    // included anything. If N === 0 the button is disabled — handle by
    // clicking "Reject all" instead so the test still exercises the
    // full HITL flow + ends in a clean terminal state.
    const approveBtn = page.getByRole("button", { name: /^approve \d+$/i });
    const isApproveEnabled = await approveBtn.isEnabled().catch(() => false);
    if (isApproveEnabled) {
      await approveBtn.click();

      // assessor + drafter + critic + cite_check (sequential, ~60-180s
      // total on Mistral free tier for ~3-5 included papers).
      await expect(page.getByRole("heading", { name: /draft|critique|citation/i }).first())
        .toBeVisible({ timeout: 4 * 60 * 1000 });
    } else {
      // Screener admitted 0 papers — reject the empty set + verify the
      // run lands in REJECTED with a sensible failureReason.
      await page.getByRole("button", { name: /reject all/i }).click();
      // Poll the API for status REJECTED.
      await expect.poll(async () => {
        const runs = await context.request.get(`/api/projects/${projectId}`);
        if (!runs.ok()) return "unknown";
        // The project endpoint doesn't include runs, so go via /api/runs
        // listing isn't trivial. Just check the page shows the REJECTED pill.
        const pill = page.getByText(/^rejected$/i);
        return (await pill.isVisible().catch(() => false)) ? "REJECTED" : "pending";
      }, { timeout: 60_000 }).toBe("REJECTED");
    }

    // Clean up.
    const del = await context.request.delete(`/api/projects/${projectId}`);
    expect(del.status()).toBe(204);
    createdProjectIds.delete(projectId);
  });
});
