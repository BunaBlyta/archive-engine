ALTER TABLE "DocumentDraft"
ADD COLUMN "editorKey" TEXT,
ADD COLUMN "artifactSha256" TEXT,
ADD COLUMN "artifactSizeBytes" INTEGER,
ADD COLUMN "artifactMimeType" TEXT,
ADD COLUMN "artifactOriginalFilename" TEXT;

CREATE UNIQUE INDEX "DocumentDraft_editorKey_key" ON "DocumentDraft"("editorKey");
