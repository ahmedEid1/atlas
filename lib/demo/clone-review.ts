import { db } from "@/lib/db";
import type { Prisma } from "@/app/generated/prisma/client";

/**
 * Deep-clone a "template" Project (and everything it owns) into a target
 * user's account. Used by /api/demo/start to give each guest visitor
 * their own private copy of the canonical ReAct-paper review.
 *
 * What gets cloned:
 *   - Project (title, question)
 *   - CorpusItems (PDFs) — keeps the same `source` blob key (PDFs are
 *     read-only; no S3 copy needed)
 *   - Runs (the SLR pipeline runs with their drafts and scores)
 *   - RunSteps (per-node trace)
 *   - HumanCheckpoints (structural only; cloned waitToken is set to null
 *     since the original token is dead by now and waitToken is @unique)
 *   - IncludedPapers (corpus item ↔ run linkage)
 *   - ExtractedClaims
 *   - ClaimChecks (cite_check verdicts)
 *
 * Foreign-key rewriting is done via per-row id maps so the cloned graph
 * is self-consistent (claims point at cloned IncludedPapers, etc.).
 *
 * Citation integrity: every `ClaimCheck.paperId` MUST resolve via the
 * corpus id map. If not, we throw rather than silently fall back to the
 * template id — a fallback would leave the guest with rows pointing at
 * a corpus item owned by a different tenant (cross-tenant pointer hazard).
 *
 * Draft rewriting: `Run.draft` embeds `[paper_id]` citation tokens whose
 * ids must also be rewritten to match the cloned corpus, otherwise the
 * audit UI shows mismatched citations after clone.
 *
 * Returns the new Project id so the caller can redirect the user to it.
 *
 * Contract: if `tx` is provided, the clone runs inside the caller's
 * transaction; otherwise it opens its own.
 */
export async function cloneReviewTemplate(args: {
  templateProjectId: string;
  targetOwnerId: string;
  tx?: Prisma.TransactionClient;
}): Promise<{ projectId: string }> {
  const template = await db.project.findUnique({
    where: { id: args.templateProjectId },
    include: {
      corpus: true,
      runs: {
        include: {
          steps: true,
          checkpoints: true,
          includedPapers: true,
          claims: true,
          claimChecks: true,
        },
      },
    },
  });

  if (!template) {
    throw new Error(
      `cloneReviewTemplate: template project ${args.templateProjectId} not found. Set DEMO_TEMPLATE_PROJECT_ID to a valid completed review.`,
    );
  }

  const work = async (tx: Prisma.TransactionClient) => {
    const newProject = await tx.project.create({
      data: {
        ownerId: args.targetOwnerId,
        title: template.title,
        question: template.question,
      },
    });

    // CorpusItems — keep `source` blob key shared (PDFs are read-only).
    const corpusIdMap = new Map<string, string>();
    for (const item of template.corpus) {
      const created = await tx.corpusItem.create({
        data: {
          projectId: newProject.id,
          kind: item.kind,
          status: item.status,
          source: item.source,
          rawText: item.rawText,
          parsedMarkdown: item.parsedMarkdown,
          failureReason: item.failureReason,
          summary: item.summary ?? undefined,
          summaryTraceUrl: item.summaryTraceUrl,
          summarisedAt: item.summarisedAt,
        },
      });
      corpusIdMap.set(item.id, created.id);
    }

    for (const run of template.runs) {
      const newRun = await tx.run.create({
        data: {
          projectId: newProject.id,
          status: run.status,
          question: run.question,
          plan: run.plan ?? undefined,
          // Rewrite [paper_id] tokens in the cloned draft so they point at
          // cloned corpus ids — keeps the audit view consistent with
          // ClaimCheck.paperId on the cloned side.
          draft: rewriteCitationsInDraft(run.draft, corpusIdMap),
          failureReason: run.failureReason,
          faithfulnessScore: run.faithfulnessScore,
          critiqueScore: run.critiqueScore,
          // triggerRunId is @unique — leave null on the clone. The cloned
          // Run is a viewable artifact, not a re-runnable workflow handle.
          createdAt: run.createdAt,
          completedAt: run.completedAt,
        },
      });

      if (run.steps.length > 0) {
        await tx.runStep.createMany({
          data: run.steps.map((s) => ({
            runId: newRun.id,
            nodeName: s.nodeName,
            startedAt: s.startedAt,
            endedAt: s.endedAt,
            traceUrl: s.traceUrl,
            inputTokens: s.inputTokens,
            outputTokens: s.outputTokens,
            cacheReadInputTokens: s.cacheReadInputTokens,
          })),
        });
      }

      if (run.checkpoints.length > 0) {
        await tx.humanCheckpoint.createMany({
          data: run.checkpoints.map((c) => ({
            runId: newRun.id,
            kind: c.kind,
            status: c.status,
            // Best-effort rewrite of any embedded corpus ids. The known
            // shape for APPROVE_PAPERS proposals is
            // { kind, includedPapers: [{ corpusItemId, ... }] } —
            // rewriteIdsInJson walks the structure generically so any
            // future fields that carry corpus ids also get fixed.
            proposal: rewriteIdsInJson(c.proposal ?? {}, corpusIdMap) as Prisma.InputJsonValue,
            decisionPayload:
              c.decisionPayload == null
                ? undefined
                : (rewriteIdsInJson(c.decisionPayload, corpusIdMap) as Prisma.InputJsonValue),
            rejectionReason: c.rejectionReason,
            waitToken: null, // @unique — can't reuse the original
            createdAt: c.createdAt,
            decidedAt: c.decidedAt,
          })),
        });
      }

      const includedPaperIdMap = new Map<string, string>();
      for (const ip of run.includedPapers) {
        const newCorpusItemId = corpusIdMap.get(ip.corpusItemId);
        if (!newCorpusItemId) continue;
        const created = await tx.includedPaper.create({
          data: {
            runId: newRun.id,
            corpusItemId: newCorpusItemId,
            relevanceScore: ip.relevanceScore,
            inclusionReason: ip.inclusionReason,
            createdAt: ip.createdAt,
          },
        });
        includedPaperIdMap.set(ip.id, created.id);
      }

      if (run.claims.length > 0) {
        const claimsToCreate = run.claims
          .map((c) => {
            const newIncludedPaperId = includedPaperIdMap.get(c.includedPaperId);
            if (!newIncludedPaperId) return null;
            return {
              runId: newRun.id,
              includedPaperId: newIncludedPaperId,
              text: c.text,
              category: c.category,
              createdAt: c.createdAt,
            };
          })
          .filter((c): c is NonNullable<typeof c> => c !== null);
        if (claimsToCreate.length > 0) {
          await tx.extractedClaim.createMany({ data: claimsToCreate });
        }
      }

      if (run.claimChecks.length > 0) {
        await tx.claimCheck.createMany({
          data: run.claimChecks.map((cc) => {
            const mappedPaperId = corpusIdMap.get(cc.paperId);
            if (!mappedPaperId) {
              // No silent fallback — falling back to cc.paperId would
              // leak a pointer at a template-owned CorpusItem into the
              // guest's project, which is a cross-tenant integrity
              // violation. Better to fail the clone loudly.
              throw new Error(
                `cloneReviewTemplate: ClaimCheck.paperId="${cc.paperId}" has no mapping in corpusIdMap. Template integrity violation — refusing to clone with cross-tenant pointer.`,
              );
            }
            return {
              runId: newRun.id,
              paperId: mappedPaperId,
              claim: cc.claim,
              verdict: cc.verdict,
              reason: cc.reason,
              paperExcerpt: cc.paperExcerpt,
              createdAt: cc.createdAt,
            };
          }),
        });
      }
    }

    return { projectId: newProject.id };
  };

  if (args.tx) {
    return work(args.tx);
  }
  // Whole clone runs in one transaction so a partial failure doesn't
  // leave the guest with half a project. Lifted timeout because nested
  // creates on the read-replica can add up.
  return db.$transaction(work, { timeout: 15_000 });
}

/**
 * Rewrite `[paper_id]` tokens in a draft string using the corpus id map.
 *
 * Citation tokens look like `[<corpusItemId>]` where the inner id is a
 * cuid-like string (alphanumeric + `_-`, at least 10 chars long). If the
 * inner id isn't in the map, the token is left alone — drafts can also
 * contain other bracketed text (e.g. `[Figure 1]`, footnote-style refs)
 * and a non-mapping bracket is not necessarily a bug. Throwing here
 * would be too aggressive.
 */
function rewriteCitationsInDraft(
  draft: string | null,
  corpusIdMap: Map<string, string>,
): string | null {
  if (!draft) return draft;
  return draft.replace(/\[([a-zA-Z0-9_-]{10,})\]/g, (full, id: string) => {
    const mapped = corpusIdMap.get(id);
    return mapped ? `[${mapped}]` : full;
  });
}

/**
 * Best-effort walk over a JSON-ish value, rewriting any string that
 * matches a key in `corpusIdMap`. Used for `HumanCheckpoint.proposal`
 * which is typed `Json` but known to contain `corpusItemId` fields
 * (see InterruptValue.APPROVE_PAPERS in trigger/run-review.ts).
 *
 * Non-string leaves are returned as-is. Cycles aren't expected in
 * Prisma-serialised JSON, so no cycle guard.
 */
function rewriteIdsInJson(value: unknown, corpusIdMap: Map<string, string>): unknown {
  if (typeof value === "string") {
    return corpusIdMap.get(value) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => rewriteIdsInJson(v, corpusIdMap));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = rewriteIdsInJson(v, corpusIdMap);
    }
    return out;
  }
  return value;
}
