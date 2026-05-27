import { db } from "@/lib/db";
import { putObject } from "@/lib/object-store";
import { parsePdfWithMistral } from "@/lib/pdf-parse";
import { addStep, finishStep } from "@/lib/agent/runs";
import { assertWithinBudget } from "@/lib/agent/cost-cap";
import { randomUUID } from "node:crypto";
import type { AgentState, DiscoveredPaperRef } from "@/lib/agent/state";

/** Hard cap on a downloaded PDF — mirrors the upload route's 25 MB. */
const MAX_PDF_BYTES = 25 * 1024 * 1024;

/** Bounded concurrent fetches (per V2 spec §5). */
const CONCURRENCY = 8;

/** Per-HEAD/GET request timeout. */
const FETCH_TIMEOUT_MS = 30_000;

/**
 * V2 fetcher node — downloads PDFs for open-access discovered papers,
 * OCRs them via Mistral, and writes a CorpusItem row that downstream
 * nodes (screener, assessor) can read.
 *
 * Paywalled / unknown-access papers are skipped silently: the screener
 * falls back to abstract-only scoring for those, and the assessor can
 * still drop them if their abstract doesn't carry enough signal.
 *
 * Concurrency is bounded at 8 so one slow provider URL doesn't stall
 * the run. Cost-cap participates per discovered paper that hits OCR
 * (we don't get an exact token count from Mistral OCR, so we estimate
 * ~50 tokens per page — same heuristic the spec §7 budgets against).
 *
 * Idempotent across retries: if a DiscoveredPaper already has a
 * `corpusItemId`, the fetcher skips it (a Trigger.dev retry of the
 * task replays the node, and we don't want to double-create CorpusItems).
 */
export async function fetcherNode(
  state: AgentState,
): Promise<Partial<AgentState>> {
  if (state.discoveredPapers.length === 0) {
    // Nothing to fetch — the discoverer surfaced nothing, or every hit
    // is paywalled. The screener can still run on abstracts.
    return {};
  }

  await assertWithinBudget(state.runId);
  const outerStep = await addStep({ runId: state.runId, nodeName: "fetcher" });

  try {
    const fetchable = state.discoveredPapers.filter(
      (p) =>
        p.accessStatus === "open" &&
        typeof p.oaUrl === "string" &&
        p.oaUrl.length > 0 &&
        p.corpusItemId === null,
    );

    const updatedRefs = await runBoundedConcurrent(
      fetchable,
      CONCURRENCY,
      (paper) => fetchOne(state, paper),
    );

    // Merge the updated refs back into the full set (keep paywalled / failed
    // entries unchanged in state so the screener still sees them).
    const updatedById = new Map(updatedRefs.map((u) => [u.id, u]));
    const merged: DiscoveredPaperRef[] = state.discoveredPapers.map(
      (p) => updatedById.get(p.id) ?? p,
    );

    const fetchedCount = updatedRefs.filter(
      (u) => u.corpusItemId !== null,
    ).length;
    const skippedCount = updatedRefs.length - fetchedCount;
    await finishStep({
      stepId: outerStep.id,
      failureReason:
        skippedCount > 0
          ? `fetched=${fetchedCount} skipped=${skippedCount} (paywalled / download failures recorded per-row)`
          : undefined,
    });

    return { discoveredPapers: merged };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await finishStep({ stepId: outerStep.id, failureReason: reason.slice(0, 1000) });
    throw err;
  }
}

/**
 * Download, OCR, persist a single discovered paper. Returns the ref with
 * `corpusItemId` populated on success; with the original null on every
 * skippable failure (404 / 4xx / non-PDF / OCR error / timeout). Throws
 * only when something unexpected happens at the DB layer — a bad PDF URL
 * is NOT an exception.
 */
async function fetchOne(
  state: AgentState,
  paper: DiscoveredPaperRef,
): Promise<DiscoveredPaperRef> {
  if (!paper.oaUrl) return paper;
  const innerStep = await addStep({
    runId: state.runId,
    nodeName: "fetcher_paper",
  });

  try {
    const bytes = await downloadPdf(paper.oaUrl);
    if (bytes === null) {
      // Non-fatal download failure — log + skip.
      await finishStep({
        stepId: innerStep.id,
        failureReason: `download failed for ${paper.externalId}`,
      });
      return paper;
    }

    const key = `corpus/discovered/${state.projectId}/${randomUUID()}.pdf`;
    await putObject(key, bytes, "application/pdf");

    const { markdown, pageCount } = await parsePdfWithMistral(bytes);

    // Build the cross-reference columns. arXiv hits use the arxiv id,
    // OpenAlex uses DOI when present (already stripped of the doi.org
    // prefix by the OpenAlex adapter).
    let externalDoi: string | null = null;
    let externalArxivId: string | null = null;
    if (paper.provider === "arxiv" && paper.externalId.startsWith("arxiv:")) {
      externalArxivId = paper.externalId.slice("arxiv:".length);
    } else if (!paper.externalId.startsWith("openalex:")) {
      // Anything not provider-prefixed is a DOI in our normalization.
      externalDoi = paper.externalId;
    }

    const corpusItem = await db.corpusItem.create({
      data: {
        projectId: state.projectId,
        kind: "PDF",
        status: "PARSED",
        source: `${paper.provider}:${paper.externalId}`,
        parsedMarkdown: markdown,
        externalDoi,
        externalArxivId,
      },
      select: { id: true },
    });
    await db.discoveredPaper.update({
      where: { id: paper.id },
      data: { corpusItemId: corpusItem.id },
    });

    await finishStep({
      stepId: innerStep.id,
      // Use the page count as a proxy for token cost (Mistral OCR isn't
      // a token-billed API but we keep the bookkeeping consistent so the
      // cost-cap sums see the discovery phase's spend).
      inputTokens: 0,
      outputTokens: pageCount * 50,
      cacheReadInputTokens: 0,
    });

    return { ...paper, corpusItemId: corpusItem.id };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await finishStep({
      stepId: innerStep.id,
      failureReason: reason.slice(0, 1000),
    });
    // Non-fatal: skip this paper. The discoverer's hits include paywalled
    // ones with abstract-only metadata, so the screener can still produce
    // a sensible decision without the full text.
    return paper;
  }
}

/** Return the PDF bytes on success; null on any expected fetch failure. */
async function downloadPdf(url: string): Promise<Uint8Array | null> {
  try {
    // HEAD first to bail out on non-PDF or oversized payloads before
    // streaming. Some servers don't expose Content-Length on HEAD; in that
    // case we accept and check the body length after the GET.
    const head = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!head.ok) return null;
    const headType = head.headers.get("content-type")?.toLowerCase() ?? "";
    if (headType && !headType.includes("pdf")) return null;
    const headLen = head.headers.get("content-length");
    if (headLen && Number(headLen) > MAX_PDF_BYTES) return null;

    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_PDF_BYTES) return null;
    return buf;
  } catch {
    return null;
  }
}

/**
 * Run `fn` over `items` with at most `n` in flight. Order is preserved
 * (Promise.all on the worker pool semantics) and errors propagate.
 */
async function runBoundedConcurrent<T, U>(
  items: T[],
  n: number,
  fn: (item: T) => Promise<U>,
): Promise<U[]> {
  const results: U[] = new Array(items.length);
  let index = 0;
  async function worker() {
    while (true) {
      const i = index++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return results;
}
