import { db } from "@/lib/db";

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
 * Returns the new Project id so the caller can redirect the user to it.
 */
export async function cloneReviewTemplate(args: {
  templateProjectId: string;
  targetOwnerId: string;
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

  // Whole clone runs in one transaction so a partial failure doesn't
  // leave the guest with half a project. Lifted timeout because nested
  // creates on the read-replica can add up.
  return db.$transaction(
    async (tx) => {
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
            draft: run.draft,
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
              proposal: c.proposal ?? {},
              decisionPayload: c.decisionPayload ?? undefined,
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
            data: run.claimChecks.map((cc) => ({
              runId: newRun.id,
              paperId: corpusIdMap.get(cc.paperId) ?? cc.paperId,
              claim: cc.claim,
              verdict: cc.verdict,
              reason: cc.reason,
              paperExcerpt: cc.paperExcerpt,
              createdAt: cc.createdAt,
            })),
          });
        }
      }

      return { projectId: newProject.id };
    },
    { timeout: 15_000 },
  );
}
