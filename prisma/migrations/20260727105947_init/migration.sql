-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "SourceKind" AS ENUM ('ARXIV', 'HACKERNEWS');

-- CreateEnum
CREATE TYPE "InteractionKind" AS ENUM ('SEEN', 'DISMISSED', 'OPENED', 'DEEPENED');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "Source" (
    "id" TEXT NOT NULL,
    "kind" "SourceKind" NOT NULL,
    "externalId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Item" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "authors" TEXT[],
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "canonicalUrl" TEXT NOT NULL,
    "summary" TEXT,
    "whyItMatters" TEXT,
    "embedding" vector(1536),
    "importanceScore" DOUBLE PRECISION,
    "signalSnapshot" JSONB,
    "clusterId" TEXT,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "publishedAtFeed" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Claim" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "quotedFrom" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeepDive" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeepDive_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Topic" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "label" TEXT NOT NULL,

    CONSTRAINT "Topic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemTopic" (
    "itemId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "ItemTopic_pkey" PRIMARY KEY ("itemId","topicId")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT,
    "image" TEXT,
    "githubId" TEXT,
    "lastVisitedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserTopic" (
    "userId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,

    CONSTRAINT "UserTopic_pkey" PRIMARY KEY ("userId","topicId")
);

-- CreateTable
CREATE TABLE "Interaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "kind" "InteractionKind" NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Interaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipelineRun" (
    "id" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "stageCounts" JSONB,
    "error" TEXT,

    CONSTRAINT "PipelineRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DroppedItem" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "externalId" TEXT,
    "detail" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DroppedItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Source_kind_fetchedAt_idx" ON "Source"("kind", "fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Source_kind_externalId_key" ON "Source"("kind", "externalId");

-- CreateIndex
CREATE INDEX "Item_clusterId_idx" ON "Item"("clusterId");

-- CreateIndex
CREATE INDEX "Item_published_importanceScore_idx" ON "Item"("published", "importanceScore" DESC);

-- CreateIndex
CREATE INDEX "Item_publishedAt_idx" ON "Item"("publishedAt");

-- CreateIndex
CREATE INDEX "Claim_itemId_idx" ON "Claim"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "DeepDive_itemId_key" ON "DeepDive"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "Topic_slug_key" ON "Topic"("slug");

-- CreateIndex
CREATE INDEX "ItemTopic_topicId_idx" ON "ItemTopic"("topicId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_githubId_key" ON "User"("githubId");

-- CreateIndex
CREATE INDEX "UserTopic_topicId_idx" ON "UserTopic"("topicId");

-- CreateIndex
CREATE INDEX "Interaction_userId_kind_idx" ON "Interaction"("userId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "Interaction_userId_itemId_kind_key" ON "Interaction"("userId", "itemId", "kind");

-- CreateIndex
CREATE INDEX "PipelineRun_startedAt_idx" ON "PipelineRun"("startedAt" DESC);

-- CreateIndex
CREATE INDEX "DroppedItem_runId_idx" ON "DroppedItem"("runId");

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeepDive" ADD CONSTRAINT "DeepDive_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemTopic" ADD CONSTRAINT "ItemTopic_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemTopic" ADD CONSTRAINT "ItemTopic_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserTopic" ADD CONSTRAINT "UserTopic_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserTopic" ADD CONSTRAINT "UserTopic_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DroppedItem" ADD CONSTRAINT "DroppedItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PipelineRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Gemini embeddings are 3072-dim by default; we request outputDimensionality=1536
-- at embed time so the column stays within pgvector's 2000-dim index limit.
-- Index is created in the task that populates embeddings (Task 11), once there
-- are rows to index.
