-- Merge ProposedChange into DocumentDraft. A unit of work was two rows (DocumentDraft +
-- ProposedChange), 1:1 and permanently so, each carrying its own mutable status. This
-- collapses them into one row so a write can no longer leave the pair inconsistent (the old
-- abandon route closed the proposal and left the draft stuck at "proposed" forever).

-- 1. New columns on DocumentDraft, mirroring what ProposedChange used to carry.
ALTER TABLE "DocumentDraft" ADD COLUMN "summary" TEXT;
ALTER TABLE "DocumentDraft" ADD COLUMN "proposedById" TEXT;
ALTER TABLE "DocumentDraft" ADD COLUMN "proposedAt" TIMESTAMP(3);
ALTER TABLE "DocumentDraft" ADD COLUMN "closedAt" TIMESTAMP(3);

-- 2. Backfill from the (still-present) ProposedChange table.
UPDATE "DocumentDraft" d
SET
  "summary" = pc."summary",
  "proposedById" = pc."openedById",
  "proposedAt" = pc."openedAt",
  "closedAt" = pc."closedAt"
FROM "ProposedChange" pc
WHERE pc."draftId" = d."id";

-- 3. Collapse status. draft.status was "proposed" the entire time a ProposedChange was open,
--    changes_requested, or (the bug) closed — it never moved off "proposed" until published.
--    Map the true combined state onto the draft now.
UPDATE "DocumentDraft" d
SET "status" = CASE pc."status"
  WHEN 'open' THEN 'in_review'
  WHEN 'changes_requested' THEN 'changes_requested'
  WHEN 'published' THEN 'published'
  WHEN 'closed' THEN 'abandoned'
  ELSE d."status"
END
FROM "ProposedChange" pc
WHERE pc."draftId" = d."id";

-- 3b. "One active draft/proposal per document" was only ever enforced for the ProposedChange
--     side (the partial unique index); a plain draft-status row was never protected by a
--     database constraint, only by an application-level check. Existing dev data has a small
--     number of documents with more than one row that is now "active" under the single index
--     below. Keep the most recently created such row per document active; the others are, in
--     practice, superseded/abandoned — relabel them so the new index can be created without
--     discarding any rows.
WITH ranked AS (
  SELECT "id", row_number() OVER (PARTITION BY "documentId" ORDER BY "createdAt" DESC) AS rn
  FROM "DocumentDraft"
  WHERE "status" IN ('draft', 'in_review', 'changes_requested')
)
UPDATE "DocumentDraft" d
SET "status" = 'abandoned', "closedAt" = COALESCE(d."closedAt", now())
FROM ranked
WHERE ranked."id" = d."id" AND ranked.rn > 1;

-- 4. Repoint Review at DocumentDraft.
ALTER TABLE "Review" ADD COLUMN "draftId" TEXT;
UPDATE "Review" r
SET "draftId" = pc."draftId"
FROM "ProposedChange" pc
WHERE pc."id" = r."proposedChangeId";
ALTER TABLE "Review" ALTER COLUMN "draftId" SET NOT NULL;

ALTER TABLE "Review" DROP CONSTRAINT "Review_proposedChangeId_fkey";
DROP INDEX "Review_workspaceId_proposedChangeId_idx";
DROP INDEX "Review_proposedChangeId_idx";
ALTER TABLE "Review" DROP COLUMN "proposedChangeId";

ALTER TABLE "Review" ADD CONSTRAINT "Review_draftId_fkey"
  FOREIGN KEY ("draftId") REFERENCES "DocumentDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Review_workspaceId_draftId_idx" ON "Review"("workspaceId", "draftId");
CREATE INDEX "Review_draftId_idx" ON "Review"("draftId");

-- 5. Repoint LineComment at DocumentDraft.
ALTER TABLE "LineComment" ADD COLUMN "draftId" TEXT;
UPDATE "LineComment" lc
SET "draftId" = pc."draftId"
FROM "ProposedChange" pc
WHERE pc."id" = lc."proposedChangeId";
ALTER TABLE "LineComment" ALTER COLUMN "draftId" SET NOT NULL;

ALTER TABLE "LineComment" DROP CONSTRAINT "LineComment_proposedChangeId_fkey";
DROP INDEX "LineComment_workspaceId_proposedChangeId_idx";
DROP INDEX "LineComment_proposedChangeId_idx";
ALTER TABLE "LineComment" DROP COLUMN "proposedChangeId";

ALTER TABLE "LineComment" ADD CONSTRAINT "LineComment_draftId_fkey"
  FOREIGN KEY ("draftId") REFERENCES "DocumentDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "LineComment_workspaceId_draftId_idx" ON "LineComment"("workspaceId", "draftId");
CREATE INDEX "LineComment_draftId_idx" ON "LineComment"("draftId");

-- 6. Drop ProposedChange. Its own FKs (to Document/Workspace/DocumentDraft/User) and the
--    ProposedChange_one_active_per_document partial index go with it.
DROP TABLE "ProposedChange";

-- 7. FK + index for the new DocumentDraft.proposedById column.
ALTER TABLE "DocumentDraft" ADD CONSTRAINT "DocumentDraft_proposedById_fkey"
  FOREIGN KEY ("proposedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "DocumentDraft_proposedById_idx" ON "DocumentDraft"("proposedById");

-- 8. Replace the old ProposedChange partial unique index with the DocumentDraft equivalent.
-- Prisma cannot express partial unique indexes, so this stays raw SQL and `prisma db push`
-- will not recreate it — see the comment on the DocumentDraft model.
CREATE UNIQUE INDEX "DocumentDraft_one_active_per_document"
  ON "DocumentDraft" ("documentId")
  WHERE "status" IN ('draft', 'in_review', 'changes_requested');
