-- CreateTable
CREATE TABLE "EvalRun" (
    "id" TEXT NOT NULL,
    "goldenId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "runId" TEXT,
    "commitSha" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvalRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EvalRun_goldenId_createdAt_idx" ON "EvalRun"("goldenId", "createdAt");

-- CreateIndex
CREATE INDEX "EvalRun_commitSha_idx" ON "EvalRun"("commitSha");
