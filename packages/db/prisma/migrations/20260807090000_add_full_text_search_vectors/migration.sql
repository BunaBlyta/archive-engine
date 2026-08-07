-- Full-text search uses the same English configuration in both generated vectors.
-- If that configuration changes, rebuild both generated columns and their GIN indexes.
ALTER TABLE "Document"
  ADD COLUMN "titleVector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce("title", ''))) STORED;

ALTER TABLE "DocumentSearch"
  ADD COLUMN "contentVector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce("plainText", ''))) STORED;

CREATE INDEX "Document_titleVector_gin"
  ON "Document" USING GIN ("titleVector");

CREATE INDEX "DocumentSearch_contentVector_gin"
  ON "DocumentSearch" USING GIN ("contentVector");
