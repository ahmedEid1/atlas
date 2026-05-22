-- CreateEnum
CREATE TYPE "CorpusItemKind" AS ENUM ('PDF', 'URL', 'NOTE');

-- CreateEnum
CREATE TYPE "CorpusItemStatus" AS ENUM ('PENDING', 'PARSING', 'PARSED', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "clerkId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CorpusItem" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" "CorpusItemKind" NOT NULL,
    "status" "CorpusItemStatus" NOT NULL DEFAULT 'PENDING',
    "source" TEXT NOT NULL,
    "rawText" TEXT,
    "parsedMarkdown" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CorpusItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_clerkId_key" ON "User"("clerkId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_clerkId_idx" ON "User"("clerkId");

-- CreateIndex
CREATE INDEX "Project_ownerId_idx" ON "Project"("ownerId");

-- CreateIndex
CREATE INDEX "CorpusItem_projectId_idx" ON "CorpusItem"("projectId");

-- CreateIndex
CREATE INDEX "CorpusItem_status_idx" ON "CorpusItem"("status");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorpusItem" ADD CONSTRAINT "CorpusItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
