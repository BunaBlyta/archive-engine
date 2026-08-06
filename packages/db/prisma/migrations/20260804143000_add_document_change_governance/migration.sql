-- Add plain-text document change governance workflow.
CREATE TABLE "DocumentDraft" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "baseVersionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "contentFormat" TEXT NOT NULL DEFAULT 'plain',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentDraft_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProposedChange" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "summary" TEXT,
    "openedById" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "ProposedChange_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "proposedChangeId" TEXT NOT NULL,
    "reviewerId" TEXT,
    "state" TEXT NOT NULL,
    "body" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DocumentDraft_workspaceId_documentId_status_idx" ON "DocumentDraft"("workspaceId", "documentId", "status");
CREATE INDEX "DocumentDraft_documentId_idx" ON "DocumentDraft"("documentId");
CREATE INDEX "DocumentDraft_baseVersionId_idx" ON "DocumentDraft"("baseVersionId");
CREATE INDEX "DocumentDraft_createdById_idx" ON "DocumentDraft"("createdById");

CREATE UNIQUE INDEX "ProposedChange_draftId_key" ON "ProposedChange"("draftId");
CREATE INDEX "ProposedChange_workspaceId_documentId_status_idx" ON "ProposedChange"("workspaceId", "documentId", "status");
CREATE INDEX "ProposedChange_documentId_idx" ON "ProposedChange"("documentId");
CREATE INDEX "ProposedChange_openedById_idx" ON "ProposedChange"("openedById");

CREATE INDEX "Review_workspaceId_proposedChangeId_idx" ON "Review"("workspaceId", "proposedChangeId");
CREATE INDEX "Review_proposedChangeId_idx" ON "Review"("proposedChangeId");
CREATE INDEX "Review_reviewerId_idx" ON "Review"("reviewerId");

ALTER TABLE "DocumentDraft" ADD CONSTRAINT "DocumentDraft_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentDraft" ADD CONSTRAINT "DocumentDraft_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentDraft" ADD CONSTRAINT "DocumentDraft_baseVersionId_fkey" FOREIGN KEY ("baseVersionId") REFERENCES "DocumentVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentDraft" ADD CONSTRAINT "DocumentDraft_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ProposedChange" ADD CONSTRAINT "ProposedChange_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProposedChange" ADD CONSTRAINT "ProposedChange_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProposedChange" ADD CONSTRAINT "ProposedChange_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "DocumentDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProposedChange" ADD CONSTRAINT "ProposedChange_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Review" ADD CONSTRAINT "Review_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Review" ADD CONSTRAINT "Review_proposedChangeId_fkey" FOREIGN KEY ("proposedChangeId") REFERENCES "ProposedChange"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Review" ADD CONSTRAINT "Review_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
