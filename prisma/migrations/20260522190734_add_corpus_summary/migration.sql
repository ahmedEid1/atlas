-- AlterTable
ALTER TABLE "CorpusItem" ADD COLUMN     "summarisedAt" TIMESTAMP(3),
ADD COLUMN     "summary" JSONB,
ADD COLUMN     "summaryTraceUrl" TEXT;
