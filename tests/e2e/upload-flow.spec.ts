import { test, expect } from "@playwright/test";
import { clerk } from "@clerk/testing/playwright";
import path from "node:path";
import dotenv from "dotenv";

// Load test credentials from .env.test
dotenv.config({ path: ".env.test" });
// Fall back to .env (which also has E2E_EMAIL/E2E_PASSWORD)
dotenv.config({ path: ".env" });

const EMAIL = process.env.E2E_EMAIL ?? "";

test.describe("upload flow", () => {
  test.beforeAll(() => {
    if (!EMAIL) {
      throw new Error("Set E2E_EMAIL in .env.test (or .env)");
    }
  });

  test("a signed-in user can create a project and upload a PDF", async ({ page }) => {
    // 1. Sign in via Clerk's server-side testing token — bypasses UI and HIBP password checks.
    //    clerk.signIn({ emailAddress }) uses the Backend API ticket strategy.
    //    Requires CLERK_SECRET_KEY in .env (loaded by playwright.config.ts).
    await page.goto("/");
    await clerk.signIn({
      page,
      emailAddress: EMAIL,
    });
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    // 2. Create a project.
    await page.getByRole("button", { name: /new project/i }).click();
    const title = `E2E ${Date.now()}`;
    await page.getByLabel(/title/i).fill(title);
    await page.getByLabel(/research question/i).fill("Does X improve Y in software engineering?");
    await page.getByRole("button", { name: /^create$/i }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible({ timeout: 10_000 });

    // 3. Upload a fixture PDF.
    //    The UploadButton renders a hidden <input type="file"> — Playwright can set files
    //    on hidden inputs directly without needing to click the visible button first.
    const pdfPath = path.resolve(__dirname, "fixtures/short.pdf");
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(pdfPath);

    // 4. The corpus item appears with status PENDING or PARSING (lowercase in the badge).
    //    We don't wait for PARSED here — see the skipped test below for why.
    const statusBadge = page.getByText(/^(pending|parsing)$/i);
    await expect(statusBadge).toBeVisible({ timeout: 15_000 });
  });

  // Skipped: requires a real Mistral OCR round-trip on every CI run — slow,
  // free-tier-rate-limited, and flaky enough to be net-negative as a smoke
  // signal. The PARSING → PARSED contract is already covered by the unit
  // test in `tests/trigger/parse-pdf.test.ts` with the Mistral SDK mocked.
  // (Earlier comment here referenced `marker-pdf` + "M3 deployment" — both
  // outdated; the parser is HTTP Mistral OCR since v0.1.0 / M1.)
  test.skip("uploaded PDF reaches PARSED status with non-empty markdown", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByText(/^parsed$/i)).toBeVisible({ timeout: 120_000 });
    await page.getByRole("button", { name: /^view$/i }).click();
    // DraftView now renders via react-markdown rather than <pre>; this
    // assertion would also need to be retargeted at the rendered markdown
    // block (e.g. a heading from the draft) if/when this test is enabled.
    const codeBlock = page.locator("pre").first();
    await expect(codeBlock).not.toBeEmpty();
  });
});
