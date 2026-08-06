-- CreateTable
CREATE TABLE "LineComment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "proposedChangeId" TEXT NOT NULL,
    "authorId" TEXT,
    "diffLineIndex" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LineComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LineComment_workspaceId_proposedChangeId_idx" ON "LineComment"("workspaceId", "proposedChangeId");

-- CreateIndex
CREATE INDEX "LineComment_proposedChangeId_idx" ON "LineComment"("proposedChangeId");

-- AddForeignKey
ALTER TABLE "LineComment" ADD CONSTRAINT "LineComment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineComment" ADD CONSTRAINT "LineComment_proposedChangeId_fkey" FOREIGN KEY ("proposedChangeId") REFERENCES "ProposedChange"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineComment" ADD CONSTRAINT "LineComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
