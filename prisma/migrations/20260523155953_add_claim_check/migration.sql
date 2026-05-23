-- CreateEnum
CREATE TYPE "ClaimCheckVerdict" AS ENUM ('SUPPORTED', 'UNSUPPORTED', 'UNCLEAR');

-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "critiqueScore" DOUBLE PRECISION,
ADD COLUMN     "faithfulnessScore" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "ClaimCheck" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "paperId" TEXT NOT NULL,
    "claim" TEXT NOT NULL,
    "verdict" "ClaimCheckVerdict" NOT NULL,
    "reason" TEXT NOT NULL,
    "paperExcerpt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClaimCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClaimCheck_runId_idx" ON "ClaimCheck"("runId");

-- AddForeignKey
ALTER TABLE "ClaimCheck" ADD CONSTRAINT "ClaimCheck_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
