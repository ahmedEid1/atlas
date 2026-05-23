-- CreateEnum
CREATE TYPE "McpCallStatus" AS ENUM ('OK', 'ERROR');

-- CreateTable
CREATE TABLE "McpCall" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "reviewId" TEXT,
    "status" "McpCallStatus" NOT NULL,
    "errorCode" TEXT,
    "latencyMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "McpCall_userId_createdAt_idx" ON "McpCall"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "McpCall_userId_toolName_createdAt_idx" ON "McpCall"("userId", "toolName", "createdAt");

