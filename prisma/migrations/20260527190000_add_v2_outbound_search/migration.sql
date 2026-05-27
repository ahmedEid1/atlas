-- V2 — outbound search pipeline.
-- Spec: docs/superpowers/specs/thoth-v2-design.md
--
-- This migration is additive and backward-compatible:
--   - New enum SearchScope (uploaded_only | outbound | hybrid)
--   - New columns on Project for search configuration (all with defaults)
--   - New columns on CorpusItem for external-id cross-referencing (nullable)
--   - New tables DiscoveredPaper + ScreeningDecision
--
-- Existing Project rows get `search_scope = 'uploaded_only'` via the column
-- default, which routes them through the V1 retriever path unchanged.

-- CreateEnum
CREATE TYPE "SearchScope" AS ENUM ('uploaded_only', 'outbound', 'hybrid');

-- AlterTable: Project gains search configuration. All new columns have
-- safe defaults so existing rows continue to behave like V1.
ALTER TABLE "Project"
  ADD COLUMN "searchScope"       "SearchScope" NOT NULL DEFAULT 'uploaded_only',
  ADD COLUMN "searchProviders"   TEXT[]        NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "searchYearStart"   INTEGER,
  ADD COLUMN "searchYearEnd"     INTEGER,
  ADD COLUMN "searchMaxHits"     INTEGER       NOT NULL DEFAULT 50,
  ADD COLUMN "skipDiscoveryGate" BOOLEAN       NOT NULL DEFAULT false;

-- AlterTable: CorpusItem gains optional external-id cross-references.
-- Uploaded items have neither; discovered items will have one or both.
ALTER TABLE "CorpusItem"
  ADD COLUMN "externalDoi"     TEXT,
  ADD COLUMN "externalArxivId" TEXT;

CREATE UNIQUE INDEX "CorpusItem_externalDoi_key"     ON "CorpusItem" ("externalDoi");
CREATE UNIQUE INDEX "CorpusItem_externalArxivId_key" ON "CorpusItem" ("externalArxivId");

-- CreateTable: DiscoveredPaper — a candidate paper returned by one provider
-- before any inclusion decision. The fetcher node populates `corpusItemId`
-- after successful PDF download + OCR.
CREATE TABLE "DiscoveredPaper" (
  "id"              TEXT             NOT NULL,
  "runId"           TEXT             NOT NULL,
  "provider"        TEXT             NOT NULL,
  "externalId"      TEXT             NOT NULL,
  "title"           TEXT             NOT NULL,
  "authors"         TEXT[]           NOT NULL,
  "abstract"        TEXT,
  "publicationYear" INTEGER,
  "venue"           TEXT,
  "citationCount"   INTEGER,
  "oaUrl"           TEXT,
  "accessStatus"    TEXT             NOT NULL,
  "initialScore"    DOUBLE PRECISION NOT NULL,
  "corpusItemId"    TEXT,
  "createdAt"       TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DiscoveredPaper_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DiscoveredPaper_corpusItemId_key" ON "DiscoveredPaper" ("corpusItemId");
CREATE UNIQUE INDEX "DiscoveredPaper_runId_externalId_key" ON "DiscoveredPaper" ("runId", "externalId");
CREATE        INDEX "DiscoveredPaper_runId_idx" ON "DiscoveredPaper" ("runId");
CREATE        INDEX "DiscoveredPaper_runId_provider_idx" ON "DiscoveredPaper" ("runId", "provider");

ALTER TABLE "DiscoveredPaper"
  ADD CONSTRAINT "DiscoveredPaper_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DiscoveredPaper"
  ADD CONSTRAINT "DiscoveredPaper_corpusItemId_fkey"
  FOREIGN KEY ("corpusItemId") REFERENCES "CorpusItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: ScreeningDecision — per-paper inclusion verdict by the
-- screener node. Replaces V1's IncludedPaper for outbound runs (the assessor
-- materializes IncludedPaper after screening in V2's outbound path).
CREATE TABLE "ScreeningDecision" (
  "id"                TEXT             NOT NULL,
  "runId"             TEXT             NOT NULL,
  "discoveredPaperId" TEXT             NOT NULL,
  "include"           BOOLEAN          NOT NULL,
  "reason"            TEXT             NOT NULL,
  "relevanceScore"    DOUBLE PRECISION NOT NULL,
  "createdAt"         TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ScreeningDecision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ScreeningDecision_discoveredPaperId_key" ON "ScreeningDecision" ("discoveredPaperId");
CREATE        INDEX "ScreeningDecision_runId_idx" ON "ScreeningDecision" ("runId");

ALTER TABLE "ScreeningDecision"
  ADD CONSTRAINT "ScreeningDecision_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ScreeningDecision"
  ADD CONSTRAINT "ScreeningDecision_discoveredPaperId_fkey"
  FOREIGN KEY ("discoveredPaperId") REFERENCES "DiscoveredPaper" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
