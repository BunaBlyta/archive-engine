-- Backstop for the application-level "one proposal awaiting review" check in
-- POST /documents/:documentId/drafts/:draftId/propose. Prisma cannot express partial unique
-- indexes, so this is declared as raw SQL and left out of schema.prisma.
CREATE UNIQUE INDEX "ProposedChange_one_active_per_document"
  ON "ProposedChange" ("documentId")
  WHERE "status" IN ('open', 'changes_requested');
