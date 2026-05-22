-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('PENDING', 'PLANNING', 'AWAITING_PLAN_APPROVAL', 'RETRIEVING', 'AWAITING_PAPERS_APPROVAL', 'ASSESSING', 'DRAFTING', 'COMPLETED', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "CheckpointKind" AS ENUM ('APPROVE_PLAN', 'APPROVE_PAPERS');

-- CreateEnum
CREATE TYPE "CheckpointStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "Run" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'PENDING',
    "question" TEXT NOT NULL,
    "plan" JSONB,
    "draft" TEXT,
    "failureReason" TEXT,
    "triggerRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunStep" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "nodeName" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "traceUrl" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadInputTokens" INTEGER NOT NULL DEFAULT 0,
    "failureReason" TEXT,

    CONSTRAINT "RunStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HumanCheckpoint" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" "CheckpointKind" NOT NULL,
    "status" "CheckpointStatus" NOT NULL DEFAULT 'PENDING',
    "proposal" JSONB NOT NULL,
    "decisionPayload" JSONB,
    "rejectionReason" TEXT,
    "waitToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "HumanCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncludedPaper" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "corpusItemId" TEXT NOT NULL,
    "relevanceScore" DOUBLE PRECISION NOT NULL,
    "inclusionReason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncludedPaper_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractedClaim" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "includedPaperId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExtractedClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Run_triggerRunId_key" ON "Run"("triggerRunId");

-- CreateIndex
CREATE INDEX "Run_projectId_idx" ON "Run"("projectId");

-- CreateIndex
CREATE INDEX "Run_status_idx" ON "Run"("status");

-- CreateIndex
CREATE INDEX "RunStep_runId_idx" ON "RunStep"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "HumanCheckpoint_waitToken_key" ON "HumanCheckpoint"("waitToken");

-- CreateIndex
CREATE INDEX "HumanCheckpoint_runId_idx" ON "HumanCheckpoint"("runId");

-- CreateIndex
CREATE INDEX "HumanCheckpoint_status_idx" ON "HumanCheckpoint"("status");

-- CreateIndex
CREATE INDEX "IncludedPaper_runId_idx" ON "IncludedPaper"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "IncludedPaper_runId_corpusItemId_key" ON "IncludedPaper"("runId", "corpusItemId");

-- CreateIndex
CREATE INDEX "ExtractedClaim_runId_idx" ON "ExtractedClaim"("runId");

-- CreateIndex
CREATE INDEX "ExtractedClaim_includedPaperId_idx" ON "ExtractedClaim"("includedPaperId");

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunStep" ADD CONSTRAINT "RunStep_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HumanCheckpoint" ADD CONSTRAINT "HumanCheckpoint_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncludedPaper" ADD CONSTRAINT "IncludedPaper_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncludedPaper" ADD CONSTRAINT "IncludedPaper_corpusItemId_fkey" FOREIGN KEY ("corpusItemId") REFERENCES "CorpusItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractedClaim" ADD CONSTRAINT "ExtractedClaim_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractedClaim" ADD CONSTRAINT "ExtractedClaim_includedPaperId_fkey" FOREIGN KEY ("includedPaperId") REFERENCES "IncludedPaper"("id") ON DELETE CASCADE ON UPDATE CASCADE;
