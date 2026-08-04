-- Add archive state for documents without deleting versions, blobs, search rows, or audit history.
ALTER TABLE "Document" ADD COLUMN "archivedAt" TIMESTAMP(3);

DROP INDEX "Document_workspaceId_createdAt_idx";
CREATE INDEX "Document_workspaceId_archivedAt_createdAt_idx" ON "Document"("workspaceId", "archivedAt", "createdAt");
