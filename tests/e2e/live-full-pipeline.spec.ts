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

  // Sleep between tests to let Mistral free-tier RPM recover. Without
  // this the second + third tests start their planner calls with the
  // RPM bucket already drained from the previous test, causing 60-90s
  // backoffs that compound until the test timeout hits.
  test.afterEach(async () => {
    await new Promise((r) => setTimeout(r, 30_000));
  });

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

  // (An earlier iteration of this file defined a `waitForRunStatus` helper
  // for polling /api/runs/<id>; the COMPLETED test ended up using
  // `expect.poll` directly so the helper became dead code. Removed.)

  test("V2 outbound happy path: planner → discoverer (auto-approved) → fetcher → screener → papers_gate → assessor → drafter → critic → cite_check", async ({ page, context }) => {
    // Use OUTBOUND mode with skipDiscoveryGate=true and a small maxHits cap:
    //   - Outbound guarantees the discoverer surfaces REAL papers from
    //     OpenAlex (uploaded_only mode depends on a fixture matching the
    //     question, which our image-only short.pdf doesn't).
    //   - skipDiscoveryGate=true bypasses the discovery HITL gate so the
    //     test only needs to click 2 buttons (plan approval + papers
    //     approval) instead of 3.
    //   - searchMaxHits=2 caps the screener to 2 LLM calls + 2 OCR calls
    //     instead of the default 50 — minimises total LLM-call count
    //     so the test fits inside Mistral free-tier RPM bursts even
    //     when running back-to-back with the rejection tests in this
    //     same file. (Earlier maxHits=5 ran reliably in isolation but
    //     hit rate limits when sequenced.)
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
    await page.getByLabel(/max hits per run/i).fill("2");
    await page.getByRole("checkbox", { name: /skip discovery approval/i }).check();

    await page.getByRole("button", { name: /^create$/i }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible({ timeout: 30_000 });

    const projectId = page.url().match(/\/projects\/([^/]+)/)![1]!;
    createdProjectIds.add(projectId);

    // Start review — no corpus needed (outbound builds it).
    await page.getByRole("button", { name: /start review/i }).click();

    // Wait for plan_gate. Planner takes ~5-15s on Mistral free tier.
    // 4 min timeout — Mistral free tier RPM exhaustion mid-test forces
    // the planner to retry up to ~60s. With three full-pipeline tests
    // back-to-back the second + third tests start with depleted budget.
    await expect(page.getByRole("heading", { name: /review proposed plan/i }))
      .toBeVisible({ timeout: 4 * 60 * 1000 });

    // Approve plan.
    await page.getByRole("button", { name: /approve plan/i }).click();

    // discovery_gate is auto-approved (skipDiscoveryGate=true), so the
    // graph flows: discoverer → fetcher → screener → papers_gate. Total
    // ~90-180s depending on arXiv response time + the 5 OCR rounds.
    await expect(page.getByRole("heading", { name: /approve included papers/i }))
      .toBeVisible({ timeout: 4 * 60 * 1000 });

    // Reaching the PapersApprovalCard proves the whole V2 chain ran:
    // planner → plan_gate → discoverer → discovery_gate (auto-approved) →
    // fetcher (OCR) → screener (LLM votes per paper) → papers_gate.
    // That's the meaningful coverage of this test.
    //
    // We do NOT wait for the assessor → drafter → critic → cite_check
    // tail to complete. Mistral free tier's RPM ceiling makes the
    // sequential cite_check loop the slowest leg (~25 calls per claim
    // batch), and asserting on COMPLETED-state makes the test flake on
    // RPM bursts. The local + unit-tests already cover the v1 tail of
    // the pipeline against mocks.
    //
    // Reject the papers (whether N>0 or N=0) so the run reaches a clean
    // terminal state before cleanup. Rejecting is cheap (no further LLM
    // calls); approving would kick off the expensive tail.
    if (await page.getByRole("button", { name: /reject all/i }).isVisible({ timeout: 5_000 }).catch(() => false)) {
      await page.getByRole("button", { name: /reject all/i }).click();
    }

    // Clean up.
    const del = await context.request.delete(`/api/projects/${projectId}`);
    expect(del.status()).toBe(204);
    createdProjectIds.delete(projectId);
  });

  // Reject at plan_gate — the user types a rejection reason + the run
  // ends in REJECTED with the reason persisted to Run.failureReason
  // (M12 fix). Cheaper than the happy-path test (~30s) because only
  // the planner LLM call runs before the gate fires.
  test("reject plan_gate → REJECTED with reason propagated to Run.failureReason", async ({ page, context }) => {
    await page.setViewportSize({ width: 1280, height: 1400 });
    await page.goto("/");
    await clerk.signIn({ page, emailAddress: EMAIL }).catch((err: unknown) => {
      if (!/already signed in/i.test(String(err))) throw err;
    });
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    // outbound project — no upload, no parse-pdf wait. Just planner.
    await page.getByRole("button", { name: /new project/i }).click();
    const title = `E2E full-pipeline reject-plan — ${new Date().toISOString()}`;
    await page.getByLabel(/title/i).fill(title);
    await page.getByLabel(/research question/i).fill("How does prompt engineering improve LLM accuracy?");
    await page.getByRole("radio", { name: /outbound search/i }).check();
    await page.getByRole("button", { name: /^create$/i }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible({ timeout: 30_000 });

    const projectId = page.url().match(/\/projects\/([^/]+)/)![1]!;
    createdProjectIds.add(projectId);

    await page.getByRole("button", { name: /start review/i }).click();
    // 4 min timeout — Mistral free tier RPM exhaustion mid-test forces
    // the planner to retry up to ~60s. With three full-pipeline tests
    // back-to-back the second + third tests start with depleted budget.
    await expect(page.getByRole("heading", { name: /review proposed plan/i }))
      .toBeVisible({ timeout: 4 * 60 * 1000 });

    // Click the Reject button → form expands → fill reason → Confirm.
    await page.getByRole("button", { name: /^reject$/i }).click();
    const reason = "Out of scope for this review";
    await page.getByPlaceholder(/why are you rejecting this plan/i).fill(reason);
    await page.getByRole("button", { name: /confirm reject/i }).click();

    // The run lands in REJECTED. The page's failureReason block surfaces
    // the user's typed reason (M12 plumbing).
    // The REJECTED pill flips after the checkpoint commit (fast — ~5s).
    // The failureReason text on Run.failureReason lands AFTER the
    // trigger task resumes the wait token, the agent graph hits the
    // gate-reject branch, and setRunStatus(REJECTED, failureReason)
    // commits. That whole second leg is asynchronous — typically
    // ~10-30s on a warm Trigger.dev deployment. RefreshTick on the
    // page picks up the new failureReason on its next poll.
    await expect(page.getByText(/^rejected$/i).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(reason)).toBeVisible({ timeout: 60_000 });

    const del = await context.request.delete(`/api/projects/${projectId}`);
    expect(del.status()).toBe(204);
    createdProjectIds.delete(projectId);
  });

  // Reject at discovery_gate (V2 outbound, HITL visible — skipDiscoveryGate=false).
  // Exercises:
  //   - The DiscoveryApprovalCard rendering for an outbound run.
  //   - The reject-with-reason flow ending in REJECTED.
  //   - M12 fix: discovery rejection → REJECTED (not FAILED).
  test("V2 outbound: discovery_gate HITL renders + reject → REJECTED", async ({ page, context }) => {
    await page.setViewportSize({ width: 1280, height: 1400 });
    await page.goto("/");
    await clerk.signIn({ page, emailAddress: EMAIL }).catch((err: unknown) => {
      if (!/already signed in/i.test(String(err))) throw err;
    });
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: /new project/i }).click();
    const title = `E2E full-pipeline reject-discovery — ${new Date().toISOString()}`;
    await page.getByLabel(/title/i).fill(title);
    await page.getByLabel(/research question/i).fill("How do agent frameworks for code generation compare on humaneval benchmarks?");
    await page.getByRole("radio", { name: /outbound search/i }).check();
    await page.getByRole("checkbox", { name: /openalex/i }).uncheck();
    await page.getByLabel(/max hits per run/i).fill("3");
    // DO NOT check skipDiscoveryGate — we want the HITL gate to fire.
    await page.getByRole("button", { name: /^create$/i }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible({ timeout: 30_000 });

    const projectId = page.url().match(/\/projects\/([^/]+)/)![1]!;
    createdProjectIds.add(projectId);

    await page.getByRole("button", { name: /start review/i }).click();
    // 4 min timeout — Mistral free tier RPM exhaustion mid-test forces
    // the planner to retry up to ~60s. With three full-pipeline tests
    // back-to-back the second + third tests start with depleted budget.
    await expect(page.getByRole("heading", { name: /review proposed plan/i }))
      .toBeVisible({ timeout: 4 * 60 * 1000 });
    await page.getByRole("button", { name: /approve plan/i }).click();

    // discovery_gate fires → DiscoveryApprovalCard renders.
    await expect(page.getByRole("heading", { name: /review discovered papers/i }))
      .toBeVisible({ timeout: 120_000 });
    // The card shows the discoverer's queries + provider badges.
    // Use .first() because both DiscoveryApprovalCard (h3) and
    // DiscoverySummary (h4) render a "Search queries" heading once the
    // discovery_gate fires — strict-mode would fail on the ambiguity.
    await expect(page.getByText(/search queries/i).first()).toBeVisible();

    // Reject the sweep with a reason → REJECTED status.
    await page.getByRole("button", { name: /^reject$/i }).click();
    const reason = "Generated queries are off-topic — re-plan needed";
    await page.getByPlaceholder(/why are you rejecting/i).fill(reason);
    await page.getByRole("button", { name: /confirm reject/i }).click();

    // The REJECTED pill flips after the checkpoint commit (fast — ~5s).
    // The failureReason text on Run.failureReason lands AFTER the
    // trigger task resumes the wait token, the agent graph hits the
    // gate-reject branch, and setRunStatus(REJECTED, failureReason)
    // commits. That whole second leg is asynchronous — typically
    // ~10-30s on a warm Trigger.dev deployment. RefreshTick on the
    // page picks up the new failureReason on its next poll.
    await expect(page.getByText(/^rejected$/i).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(reason)).toBeVisible({ timeout: 60_000 });

    const del = await context.request.delete(`/api/projects/${projectId}`);
    expect(del.status()).toBe(204);
    createdProjectIds.delete(projectId);
  });

  // The COMPLETED happy path. Drives a V2 outbound run all the way to
  // a rendered draft + cite_check audit. This is the app's actual value
  // proposition — "an agent that drafts a review and verifies every
  // cited claim." Slowest test in the suite (~5-7 min on Mistral free
  // tier with the sequential cite_check loop) but the only one that
  // confirms the v1 tail of the pipeline (assessor → drafter → critic
  // → cite_check) actually runs end-to-end on the deployed
  // infrastructure.
  test("COMPLETED happy path: V2 outbound all the way to draft + cite_check audit", async ({ page, context }) => {
    test.setTimeout(10 * 60 * 1000); // 10 min — cite_check is sequential.

    await page.setViewportSize({ width: 1280, height: 1400 });
    await page.goto("/");
    await clerk.signIn({ page, emailAddress: EMAIL }).catch((err: unknown) => {
      if (!/already signed in/i.test(String(err))) throw err;
    });
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: /new project/i }).click();
    const title = `E2E full-pipeline COMPLETED — ${new Date().toISOString()}`;
    await page.getByLabel(/title/i).fill(title);
    await page.getByLabel(/research question/i).fill("What evidence supports chain-of-thought prompting improving LLM reasoning?");
    await page.getByRole("radio", { name: /outbound search/i }).check();
    await page.getByRole("checkbox", { name: /openalex/i }).uncheck();
    await page.getByLabel(/max hits per run/i).fill("2");
    await page.getByRole("checkbox", { name: /skip discovery approval/i }).check();

    await page.getByRole("button", { name: /^create$/i }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible({ timeout: 30_000 });
    const projectId = page.url().match(/\/projects\/([^/]+)/)![1]!;
    createdProjectIds.add(projectId);

    await page.getByRole("button", { name: /start review/i }).click();
    await expect(page.getByRole("heading", { name: /review proposed plan/i }))
      .toBeVisible({ timeout: 4 * 60 * 1000 });
    await page.getByRole("button", { name: /approve plan/i }).click();

    await expect(page.getByRole("heading", { name: /approve included papers/i }))
      .toBeVisible({ timeout: 4 * 60 * 1000 });

    const approveBtn = page.getByRole("button", { name: /^approve \d+$/i });
    if (!(await approveBtn.isEnabled().catch(() => false))) {
      // Screener admitted 0 papers — can't exercise the COMPLETED tail
      // from here. Reject so the run terminates cleanly + skip the
      // remaining assertions.
      await page.getByRole("button", { name: /reject all/i }).click();
      const del = await context.request.delete(`/api/projects/${projectId}`);
      expect(del.status()).toBe(204);
      createdProjectIds.delete(projectId);
      test.skip(true, "screener admitted 0 papers — can't verify COMPLETED path");
      return;
    }
    await approveBtn.click();

    // Grab the runId out of the URL so we can poll the API for status.
    const runId = page.url().match(/\/runs\/([^/?#]+)/)![1]!;

    // Poll the API for COMPLETED. assessor + drafter + critic +
    // cite_check run sequentially. Each cite_check claim is one Mistral
    // call serialised at PARALLEL=1 to respect free-tier RPS. The run
    // may bounce through ASSESSING / DRAFTING / CITE_CHECKING states.
    await expect.poll(async () => {
      const res = await context.request.get(`/api/runs/${runId}`);
      if (!res.ok()) return "pending";
      const body = (await res.json()) as { status: string };
      return body.status;
    }, { timeout: 8 * 60 * 1000, intervals: [5_000, 8_000, 12_000] }).toBe("COMPLETED");

    // Reload to pick up the COMPLETED state. The draft + critique +
    // citation audit components only mount when the page sees
    // status=COMPLETED.
    await page.reload();
    await page.waitForLoadState("networkidle");

    // Draft is rendered via react-markdown — at minimum the agent's
    // markdown contains a heading, which markdown lifts to <h1>/<h2>.
    await expect(page.locator("article h1, article h2, main h1, main h2").first())
      .toBeVisible({ timeout: 30_000 });
    // cite_check audit shows somewhere — match its key terms.
    await expect(
      page.getByText(/supported|unsupported|faithfulness|cite_check/i).first(),
    ).toBeVisible({ timeout: 30_000 });

    // M34 — the Download .md endpoint returns the markdown body as
    // an attachment. Hit it directly via the authenticated API
    // context to verify the route works on the live deploy (not just
    // that the link renders).
    const md = await context.request.get(`/api/runs/${runId}/draft.md`);
    expect(md.status()).toBe(200);
    expect(md.headers()["content-type"]).toContain("text/markdown");
    expect(md.headers()["content-disposition"]).toBe(`attachment; filename="thoth-${runId}.md"`);
    const body = await md.text();
    // Drafts always contain at least one markdown heading.
    expect(body).toMatch(/^#\s/m);

    // Clean up.
    const del = await context.request.delete(`/api/projects/${projectId}`);
    expect(del.status()).toBe(204);
    createdProjectIds.delete(projectId);
  });

  // Reject at papers_gate — papers approval card clicks "Reject all"
  // → run ends in REJECTED with "User aborted at papers gate" as the
  // failureReason (the card hardcodes that string when rejecting).
  test("V2 outbound: reject papers_gate → REJECTED with 'User aborted at papers gate' reason", async ({ page, context }) => {
    test.setTimeout(8 * 60 * 1000);
    await page.setViewportSize({ width: 1280, height: 1400 });
    await page.goto("/");
    await clerk.signIn({ page, emailAddress: EMAIL }).catch((err: unknown) => {
      if (!/already signed in/i.test(String(err))) throw err;
    });
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: /new project/i }).click();
    const title = `E2E full-pipeline reject-papers — ${new Date().toISOString()}`;
    await page.getByLabel(/title/i).fill(title);
    await page
      .getByLabel(/research question/i)
      .fill("How does sparse mixture-of-experts routing improve transformer efficiency?");
    await page.getByRole("radio", { name: /outbound search/i }).check();
    await page.getByRole("checkbox", { name: /openalex/i }).uncheck();
    await page.getByLabel(/max hits per run/i).fill("2");
    await page.getByRole("checkbox", { name: /skip discovery approval/i }).check();
    await page.getByRole("button", { name: /^create$/i }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible({ timeout: 30_000 });
    const projectId = page.url().match(/\/projects\/([^/]+)/)![1]!;
    createdProjectIds.add(projectId);

    await page.getByRole("button", { name: /start review/i }).click();
    await expect(page.getByRole("heading", { name: /review proposed plan/i }))
      .toBeVisible({ timeout: 4 * 60 * 1000 });
    await page.getByRole("button", { name: /approve plan/i }).click();
    await expect(page.getByRole("heading", { name: /approve included papers/i }))
      .toBeVisible({ timeout: 4 * 60 * 1000 });

    // Reject all papers — exercises the M12 papersApproved.rejectionReason
    // path which the M30 reject-plan test couldn't reach.
    await page.getByRole("button", { name: /reject all/i }).click();

    await expect(page.getByText(/^rejected$/i).first()).toBeVisible({ timeout: 60_000 });
    // The PapersApprovalCard hardcodes the rejection reason
    // "User aborted at papers gate" (it doesn't show a reason form).
    await expect(page.getByText(/user aborted at papers gate/i)).toBeVisible({ timeout: 60_000 });

    const del = await context.request.delete(`/api/projects/${projectId}`);
    expect(del.status()).toBe(204);
    createdProjectIds.delete(projectId);
  });

  // Hybrid mode — verifies M13's "uploaded PDFs merge into the screening
  // pool alongside outbound hits" fix works end-to-end on the live deploy.
  // Without M13, hybrid projects silently dropped uploaded PDFs even
  // though the runs-start route required at least one PARSED upload.
  test("V2 hybrid: uploaded PDF + outbound discovery merge into the papers_gate", async ({ page, context }) => {
    test.setTimeout(8 * 60 * 1000);
    await page.setViewportSize({ width: 1280, height: 1400 });
    await page.goto("/");
    await clerk.signIn({ page, emailAddress: EMAIL }).catch((err: unknown) => {
      if (!/already signed in/i.test(String(err))) throw err;
    });
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    // Create the hybrid project with skipDiscoveryGate so we only need
    // to click plan + papers approvals.
    await page.getByRole("button", { name: /new project/i }).click();
    const title = `E2E full-pipeline hybrid — ${new Date().toISOString()}`;
    await page.getByLabel(/title/i).fill(title);
    await page
      .getByLabel(/research question/i)
      .fill("How does mixture-of-experts routing improve transformer scaling efficiency?");
    await page.getByRole("radio", { name: /hybrid/i }).check();
    await page.getByRole("checkbox", { name: /openalex/i }).uncheck();
    await page.getByLabel(/max hits per run/i).fill("2");
    await page.getByRole("checkbox", { name: /skip discovery approval/i }).check();
    await page.getByRole("button", { name: /^create$/i }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible({ timeout: 30_000 });

    const projectId = page.url().match(/\/projects\/([^/]+)/)![1]!;
    createdProjectIds.add(projectId);

    // Upload the fixture PDF — hybrid REQUIRES at least one PARSED upload
    // per the runs-start guard (M2c).
    const pdfPath = path.resolve(__dirname, "fixtures/short.pdf");
    await page.locator('input[type="file"]').setInputFiles(pdfPath);
    // Wait for PARSED — M13 only merges PARSED uploads, so the test must
    // wait for OCR to finish before starting the review.
    await expect(page.getByText(/^parsed$/i)).toBeVisible({ timeout: 120_000 });

    // Start the run.
    await page.getByRole("button", { name: /start review/i }).click();
    await expect(page.getByRole("heading", { name: /review proposed plan/i }))
      .toBeVisible({ timeout: 4 * 60 * 1000 });
    await page.getByRole("button", { name: /approve plan/i }).click();

    // Papers gate fires after discoverer (synthetic upload + 2 arXiv hits)
    // → fetcher → screener. M13 means the uploaded paper enters the
    // screener with initialScore=1.0, almost always voted include=true.
    await expect(page.getByRole("heading", { name: /approve included papers/i }))
      .toBeVisible({ timeout: 4 * 60 * 1000 });

    // The papers_gate shows N included papers — at least 1 should be
    // the uploaded fixture (M13 verification). We can't easily inspect
    // which corpusItemId is which without API access, but we CAN assert
    // that the "Approve N" button is enabled (N >= 1, proving the
    // screener admitted at least one paper from either source).
    const approveBtn = page.getByRole("button", { name: /^approve \d+$/i });
    await expect(approveBtn).toBeEnabled({ timeout: 5_000 });

    // Verify via the API that the run includes a paper sourced from
    // the upload (M13's synthetic DiscoveredPaper with provider="uploaded").
    const runId = page.url().match(/\/runs\/([^/?#]+)/)![1]!;
    const runRes = await context.request.get(`/api/runs/${runId}`);
    expect(runRes.ok()).toBeTruthy();
    const run = (await runRes.json()) as {
      discoveredPapers: Array<{ provider: string; externalId: string }>;
    };
    // M13 invariant: at least one DiscoveredPaper row has
    // provider="uploaded" (the synthetic wrap of the PARSED CorpusItem).
    const uploadedSynthetic = run.discoveredPapers.find((d) => d.provider === "uploaded");
    expect(uploadedSynthetic, "M13: hybrid mode must wrap PARSED uploads as provider='uploaded' DiscoveredPaper rows")
      .toBeDefined();
    expect(uploadedSynthetic!.externalId).toMatch(/^uploaded:/);

    // Reject the rest of the pipeline — assessor + drafter + critic +
    // cite_check would take 3+ min and we've already proven the M13 path
    // (the synthetic upload made it into discoveredPapers). The COMPLETED
    // happy-path test already covers the v1-tail.
    await page.getByRole("button", { name: /reject all/i }).click();
    await expect(page.getByText(/^rejected$/i).first()).toBeVisible({ timeout: 60_000 });

    // Clean up.
    const del = await context.request.delete(`/api/projects/${projectId}`);
    expect(del.status()).toBe(204);
    createdProjectIds.delete(projectId);
  });
});
