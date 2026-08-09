import { Request, Response, Router, RequestHandler } from "express";
import multer from "multer";
import { Readable } from "stream";
import { createHash } from "crypto";
import { z } from "zod";
import MarkdownIt from "markdown-it";
import PDFDocument from "pdfkit";
import JSZip from "jszip";
import { prisma } from "@archive/db";
import { blobExists, getBlob, putBlob } from "@archive/storage";
import { NotFoundError, ValidationError, ForbiddenError, ConflictError } from "../middleware/errorHandler";
import { formatUserRef } from "../lib/userDisplay";
import {
  buildDraftEditorConfig,
  buildVersionEditorConfig,
  forceSaveDraftEditor,
} from "./editor";

// DOCX source files keep their native artifact for editing/publication. Mammoth
// provides clean HTML previews and a Markdown extraction for search/redlines.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mammoth = require("mammoth") as {
  convertToMarkdown: (input: { buffer: Buffer }) => Promise<{ value: string }>;
  convertToHtml: (input: { buffer: Buffer }) => Promise<{ value: string }>;
};

const router = Router({ mergeParams: true });

// Keep this in one place: changing it requires rebuilding both generated search vectors.
const SEARCH_TEXT_CONFIG = "english";
const SEARCH_HIGHLIGHT_START = "\uE000ARCHIVE_ENGINE_SEARCH_START\uE001";
const SEARCH_HIGHLIGHT_END = "\uE000ARCHIVE_ENGINE_SEARCH_END\uE001";
const SEARCH_HEADLINE_OPTIONS = [
  `StartSel=${SEARCH_HIGHLIGHT_START}`,
  `StopSel=${SEARCH_HIGHLIGHT_END}`,
  "MaxFragments=2",
  "MaxWords=35",
  "MinWords=15",
].join(",");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024,
    files: 1,
  },
});

const uploadSingleFile: RequestHandler = (req, res, next) => {
  upload.single("file")(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        next(new ValidationError("File is too large"));
        return;
      }

      next(new ValidationError(err.message));
      return;
    }

    if (err) {
      next(err);
      return;
    }

    next();
  });
};

function getStringField(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function parsePagination(req: Request) {
  const rawLimit = getStringField(req.query.limit);
  const rawOffset = getStringField(req.query.offset);
  const limit = rawLimit === undefined ? 25 : Number(rawLimit);
  const offset = rawOffset === undefined ? 0 : Number(rawOffset);

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ValidationError("Limit must be an integer between 1 and 100");
  }

  if (!Number.isInteger(offset) || offset < 0) {
    throw new ValidationError("Offset must be a non-negative integer");
  }

  return { limit, offset };
}

async function ingestUploadedFile(file: Express.Multer.File) {
  const mimeType = sourceUploadMimeType(file);

  if (!mimeType) {
    throw new ValidationError("Upload a plain text, Markdown, or DOCX file. PDF editing is not supported.");
  }

  const sha256 = createHash("sha256").update(file.buffer).digest("hex");
  const sizeBytes = file.size;

  if (!(await blobExists(sha256))) {
    await putBlob(sha256, Readable.from(file.buffer), sizeBytes, mimeType);
  }

  return { sha256, sizeBytes, mimeType };
}

function requireUploadedFile(req: Request) {
  if (!req.file) {
    throw new ValidationError("Document file is required");
  }

  return req.file;
}

function getRouteParam(req: Request, name: string) {
  const value = req.params[name];

  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`Missing route parameter: ${name}`);
  }

  return value;
}

function formatVersion(version: {
  id: string;
  version: number;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  originalFilename: string | null;
  createdAt: Date;
  createdBy?: { id: string; email: string; firstName?: string | null; lastName?: string | null } | null;
  search?: {
    status: string;
    indexedAt: Date;
    error: string | null;
  } | null;
}) {
  return {
    id: version.id,
    version: version.version,
    sha256: version.sha256,
    sizeBytes: version.sizeBytes,
    mimeType: version.mimeType,
    originalFilename: version.originalFilename,
    createdAt: version.createdAt.toISOString(),
    createdBy: version.createdBy ? formatUserRef(version.createdBy) : null,
    search: version.search
      ? {
          status: version.search.status,
          indexedAt: version.search.indexedAt.toISOString(),
          error: version.search.error,
        }
      : null,
  };
}

// HTTP header values must be Latin-1; strip combining marks and any other
// non-ASCII-printable characters so a title/filename can never crash
// res.setHeader("Content-Disposition", ...) with ERR_INVALID_CHAR.
function asciiSafeFilename(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, "-");
}

function safeDownloadFilename(filename: string | null, title: string, version: number) {
  const name = asciiSafeFilename(filename ?? `${title}-v${version}`);
  const safeName = name
    .trim()
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 120);

  return safeName || `document-v${version}`;
}

function contentDispositionFilename(filename: string) {
  return filename.replace(/"/g, "");
}

function escapeHtml(value: string) {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };

  return value.replace(/[&<>"']/g, (character) => entities[character] ?? character);
}

function parseVersionParam(value: string) {
  const version = Number(value);

  if (!Number.isInteger(version) || version < 1) {
    throw new ValidationError("Version must be a positive integer");
  }

  return version;
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

async function streamToString(stream: Readable): Promise<string> {
  return (await streamToBuffer(stream)).toString("utf8");
}

const WORD_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function isEditableSourceMimeType(mimeType: string) {
  const normalized = mimeType.toLowerCase();
  return normalized === "text/plain" || normalized === "text/markdown" || normalized === WORD_MIME_TYPE;
}

function filenameExtension(filename: string) {
  const normalized = filename.toLowerCase();
  const dot = normalized.lastIndexOf(".");
  return dot === -1 ? "" : normalized.slice(dot);
}

function sourceUploadMimeType(file: Express.Multer.File) {
  const extension = filenameExtension(file.originalname);

  if (extension === ".txt") return "text/plain";
  if (extension === ".md" || extension === ".markdown") return "text/markdown";
  if (extension === ".docx") return WORD_MIME_TYPE;
  if (extension) return null;

  const mimeType = (file.mimetype || "").toLowerCase();
  if (mimeType === "text/plain" || mimeType === "text/markdown") return mimeType;
  if (mimeType === WORD_MIME_TYPE) return WORD_MIME_TYPE;
  return null;
}

// Keyed on the RESOLVED type, not the extension: an upload with no extension takes its type
// from the declared Content-Type, and that route needs the same content check.
async function assertSourceUploadContentMatchesType(file: Express.Multer.File, mimeType: string) {
  // Names what the upload claimed to be, whichever way it claimed it.
  const claimed = filenameExtension(file.originalname) || mimeType;

  if (mimeType === "text/plain" || mimeType === "text/markdown") {
    if (file.buffer.includes(0)) {
      throw new ValidationError(`This file is named ${claimed} but its contents are not valid UTF-8 text.`);
    }

    try {
      new TextDecoder("utf-8", { fatal: true }).decode(file.buffer);
    } catch {
      throw new ValidationError(`This file is named ${claimed} but its contents are not valid UTF-8 text.`);
    }

    return;
  }

  if (mimeType === WORD_MIME_TYPE) {
    try {
      const zip = await JSZip.loadAsync(file.buffer);
      const hasContentTypes = zip.file("[Content_Types].xml") !== null;
      const hasWordDocument = zip.file("word/document.xml") !== null;

      if (hasContentTypes && hasWordDocument) return;
    } catch {
      // Report all invalid DOCX bytes with the same content-mismatch error.
    }

    throw new ValidationError(`This file is named ${claimed} but its contents are not a Word document.`);
  }
}

async function assertSupportedSourceUpload(file: Express.Multer.File) {
  const mimeType = sourceUploadMimeType(file);

  if (!mimeType) {
    throw new ValidationError("Upload a plain text, Markdown, or DOCX file. PDF editing is not supported.");
  }

  await assertSourceUploadContentMatchesType(file, mimeType);
}

async function readTextVersion(version: { sha256: string; mimeType: string }) {
  if (!isEditableSourceMimeType(version.mimeType)) {
    throw new ValidationError("Only plain text, Markdown, or DOCX documents can be edited in the current editor");
  }

  const source = await getBlob(version.sha256);

  if (version.mimeType.toLowerCase() !== WORD_MIME_TYPE) {
    return streamToString(source);
  }

  try {
    const result = await mammoth.convertToMarkdown({ buffer: await streamToBuffer(source) });
    return result.value;
  } catch (error) {
    throw new ValidationError(
      `DOCX content could not be converted for preview or editing: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// ProposedChange was merged into DocumentDraft (see the migration and the model comment on
// DocumentDraft). Storage now uses one combined status vocabulary; the API still exposes the
// two vocabularies callers (the React app) already depend on. All translation between stored
// and wire vocabulary is contained here so it never leaks into route handlers. Unifying the
// API/web vocabulary with the storage vocabulary is a deliberate follow-up, not done here.
const DRAFT_WIRE_STATUS: Record<string, string> = {
  draft: "draft",
  in_review: "proposed",
  changes_requested: "proposed",
  published: "published",
  abandoned: "abandoned",
};

const PROPOSAL_WIRE_STATUS: Record<string, string> = {
  in_review: "open",
  changes_requested: "changes_requested",
  published: "published",
  abandoned: "closed",
};

function formatDraft(draft: {
  id: string;
  workspaceId: string;
  documentId: string;
  baseVersionId: string;
  title: string;
  content: string;
  contentFormat: string;
  status: string;
  editorKey: string | null;
  artifactSha256: string | null;
  artifactSizeBytes: number | null;
  artifactMimeType: string | null;
  artifactOriginalFilename: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: draft.id,
    workspaceId: draft.workspaceId,
    documentId: draft.documentId,
    baseVersionId: draft.baseVersionId,
    title: draft.title,
    content: draft.content,
    contentFormat: draft.contentFormat,
    status: DRAFT_WIRE_STATUS[draft.status] ?? draft.status,
    editorKey: draft.editorKey,
    artifactSha256: draft.artifactSha256,
    artifactSizeBytes: draft.artifactSizeBytes,
    artifactMimeType: draft.artifactMimeType,
    artifactOriginalFilename: draft.artifactOriginalFilename,
    createdById: draft.createdById,
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString(),
  };
}

function formatDraftMetadata(draft: {
  id: string;
  workspaceId: string;
  documentId: string;
  baseVersionId: string;
  title: string;
  contentFormat: string;
  status: string;
  editorKey: string | null;
  artifactSha256: string | null;
  artifactSizeBytes: number | null;
  artifactMimeType: string | null;
  artifactOriginalFilename: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: draft.id,
    workspaceId: draft.workspaceId,
    documentId: draft.documentId,
    baseVersionId: draft.baseVersionId,
    title: draft.title,
    contentFormat: draft.contentFormat,
    status: DRAFT_WIRE_STATUS[draft.status] ?? draft.status,
    editorKey: draft.editorKey,
    artifactSha256: draft.artifactSha256,
    artifactSizeBytes: draft.artifactSizeBytes,
    artifactMimeType: draft.artifactMimeType,
    artifactOriginalFilename: draft.artifactOriginalFilename,
    createdById: draft.createdById,
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString(),
  };
}

// The proposed-change id is simply the draft id now — there is no separate row. Only call
// this for a draft that has actually been proposed (status !== "draft"), so proposedAt is
// always set in practice even though the column is nullable.
function formatProposedChange(draft: {
  id: string;
  workspaceId: string;
  documentId: string;
  status: string;
  summary: string | null;
  proposedById: string | null;
  proposedAt: Date | null;
  closedAt: Date | null;
}) {
  return {
    id: draft.id,
    workspaceId: draft.workspaceId,
    documentId: draft.documentId,
    draftId: draft.id,
    status: PROPOSAL_WIRE_STATUS[draft.status] ?? draft.status,
    summary: draft.summary,
    openedById: draft.proposedById,
    openedAt: (draft.proposedAt ?? draft.closedAt ?? new Date()).toISOString(),
    closedAt: draft.closedAt?.toISOString() ?? null,
  };
}

function formatReview(review: {
  id: string;
  workspaceId: string;
  draftId: string;
  reviewerId: string | null;
  reviewer?: { id: string; email: string; firstName?: string | null; lastName?: string | null } | null;
  state: string;
  body: string | null;
  createdAt: Date;
}) {
  return {
    id: review.id,
    workspaceId: review.workspaceId,
    proposedChangeId: review.draftId,
    reviewerId: review.reviewerId,
    reviewer: review.reviewer ? formatUserRef(review.reviewer) : null,
    state: review.state,
    body: review.body,
    createdAt: review.createdAt.toISOString(),
  };
}

function splitDiffLines(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines;
}

const MAX_DIFF_LCS_CELLS = 1_000_000;

type DiffLine = {
  type: "unchanged" | "added" | "removed";
  oldLineNumber: number | null;
  newLineNumber: number | null;
  text: string;
};

type LineDiffResult =
  | { type: "line"; lines: DiffLine[] }
  | {
      type: "too_large";
      baseLineCount: number;
      draftLineCount: number;
      maxCellCount: number;
      cellCount: number;
      message: string;
    };

function createLineDiff(baseContent: string, draftContent: string): LineDiffResult {
  const baseLines = splitDiffLines(baseContent);
  const draftLines = splitDiffLines(draftContent);
  const lcsCellCount = (baseLines.length + 1) * (draftLines.length + 1);

  if (lcsCellCount > MAX_DIFF_LCS_CELLS) {
    return {
      type: "too_large",
      baseLineCount: baseLines.length,
      draftLineCount: draftLines.length,
      maxCellCount: MAX_DIFF_LCS_CELLS,
      cellCount: lcsCellCount,
      message: "This proposed change is too large for inline line-by-line review.",
    };
  }

  const lcs: number[][] = Array.from({ length: baseLines.length + 1 }, () =>
    Array(draftLines.length + 1).fill(0)
  );

  for (let i = baseLines.length - 1; i >= 0; i -= 1) {
    for (let j = draftLines.length - 1; j >= 0; j -= 1) {
      lcs[i][j] =
        baseLines[i] === draftLines[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < baseLines.length || j < draftLines.length) {
    if (i < baseLines.length && j < draftLines.length && baseLines[i] === draftLines[j]) {
      lines.push({
        type: "unchanged",
        oldLineNumber: i + 1,
        newLineNumber: j + 1,
        text: baseLines[i],
      });
      i += 1;
      j += 1;
    } else if (j < draftLines.length && (i === baseLines.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      lines.push({
        type: "added",
        oldLineNumber: null,
        newLineNumber: j + 1,
        text: draftLines[j],
      });
      j += 1;
    } else if (i < baseLines.length) {
      lines.push({
        type: "removed",
        oldLineNumber: i + 1,
        newLineNumber: null,
        text: baseLines[i],
      });
      i += 1;
    }
  }

  return {
    type: "line",
    lines,
  };
}

function textFilenameFromTitle(title: string, version: number, format: "plain" | "markdown" | "pdf" = "plain") {
  const baseName = asciiSafeFilename(title)
    .trim()
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 100)
    .replace(/^-|-$/g, "")
    .toLowerCase();

  const ext = format === "markdown" ? "md" : format === "pdf" ? "pdf" : "txt";
  return `${baseName || "document"}-v${version}.${ext}`;
}

function publicationFilenameFromTitle(title: string, version: number, mimeType: string) {
  if (mimeType === WORD_MIME_TYPE) {
    return textFilenameFromTitle(title, version, "plain").replace(/\.txt$/i, ".docx");
  }

  return textFilenameFromTitle(
    title,
    version,
    mimeType === "text/markdown" ? "markdown" : "plain"
  );
}

function draftEditorKey(baseVersionId: string, actorId: string) {
  return createHash("sha256")
    .update(`${baseVersionId}:${actorId}:${Date.now()}`)
    .digest("hex")
    .slice(0, 40);
}

function auditRequestMetadata(req: Request) {
  return {
    ip: req.ip,
    userAgent: req.get("user-agent"),
  };
}

async function lockDocumentForUpdate(
  tx: { $queryRaw: typeof prisma.$queryRaw },
  workspaceId: string,
  documentId: string
) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "Document"
    WHERE "id" = ${documentId}
      AND "workspaceId" = ${workspaceId}
      AND "archivedAt" IS NULL
    FOR UPDATE
  `;

  if (rows.length === 0) {
    throw new NotFoundError("Document not found");
  }
}

type SearchJobTransaction = {
  documentSearch: typeof prisma.documentSearch;
  job: typeof prisma.job;
  $queryRaw: typeof prisma.$queryRaw;
};

type PublishTransaction = SearchJobTransaction & {
  blob: typeof prisma.blob;
  documentVersion: typeof prisma.documentVersion;
  documentDraft: typeof prisma.documentDraft;
  auditLog: typeof prisma.auditLog;
};

async function createSearchIndexJob(
  tx: SearchJobTransaction,
  version: { id: string; workspaceId: string; documentId: string }
) {
  await tx.documentSearch.create({
    data: {
      versionId: version.id,
      workspaceId: version.workspaceId,
      status: "pending",
    },
  });

  await tx.job.create({
    data: {
      type: "INDEX_DOCUMENT_VERSION",
      payload: {
        versionId: version.id,
        workspaceId: version.workspaceId,
        documentId: version.documentId,
      },
    },
  });
}

async function readReviewBaseContent(version: {
  sha256: string;
  mimeType: string;
  search?: {
    status: string;
    plainText?: string | null;
  } | null;
}) {
  if (isEditableSourceMimeType(version.mimeType)) {
    return readTextVersion(version);
  }

  throw new ValidationError("Only plain text, Markdown, or DOCX documents can be reviewed in the current editor");
}

// The redline is built from markdown extracted out of word/document.xml — it only covers body
// text. Everything else in the .docx zip (headers, footers, comments, footnotes, endnotes,
// media, styles, theme) is invisible to it. This fingerprints just those other entries so the
// review UI can flag "something changed here that you won't see in the redline" without trying
// to show what changed. Tracked changes and table layout live inside word/document.xml itself,
// alongside the body text, so they can't be isolated this way and are deliberately not covered.
const DOCX_FINGERPRINT_CATEGORIES: { label: string; test: (entryName: string) => boolean }[] = [
  { label: "header", test: (name) => /^word\/header\d*\.xml$/.test(name) },
  { label: "footer", test: (name) => /^word\/footer\d*\.xml$/.test(name) },
  { label: "comments", test: (name) => name === "word/comments.xml" },
  { label: "footnotes", test: (name) => name === "word/footnotes.xml" },
  { label: "endnotes", test: (name) => name === "word/endnotes.xml" },
  { label: "images", test: (name) => name.startsWith("word/media/") },
  { label: "styles", test: (name) => name === "word/styles.xml" },
  { label: "theme", test: (name) => name.startsWith("word/theme/") },
];

function docxFingerprintLabel(entryName: string): string | null {
  return DOCX_FINGERPRINT_CATEGORIES.find((category) => category.test(entryName))?.label ?? null;
}

async function computeDocxFingerprint(buffer: Buffer): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(buffer);
  const fingerprint: Record<string, string> = {};

  for (const entry of Object.values(zip.files)) {
    if (entry.dir || !docxFingerprintLabel(entry.name)) continue;
    const content = await entry.async("nodebuffer");
    fingerprint[entry.name] = createHash("sha256").update(content).digest("hex");
  }

  return fingerprint;
}

// Read-only: only ever compares two fingerprints and reports which labeled categories differ.
// Never writes anything back into either document.
function diffDocxFingerprints(base: Record<string, string>, draft: Record<string, string>): string[] {
  const changedLabels = new Set<string>();

  for (const name of new Set([...Object.keys(base), ...Object.keys(draft)])) {
    if (base[name] !== draft[name]) {
      const label = docxFingerprintLabel(name);
      if (label) changedLabels.add(label);
    }
  }

  return [...changedLabels];
}

async function computeDocxHiddenChanges(
  draft: { artifactSha256: string | null; artifactMimeType: string | null },
  baseVersion: { sha256: string; mimeType: string }
): Promise<string[]> {
  if (
    draft.artifactMimeType !== WORD_MIME_TYPE ||
    !draft.artifactSha256 ||
    baseVersion.mimeType !== WORD_MIME_TYPE
  ) {
    return [];
  }

  const [baseBuffer, draftBuffer] = await Promise.all([
    streamToBuffer(await getBlob(baseVersion.sha256)),
    streamToBuffer(await getBlob(draft.artifactSha256)),
  ]);
  const [baseFingerprint, draftFingerprint] = await Promise.all([
    computeDocxFingerprint(baseBuffer),
    computeDocxFingerprint(draftBuffer),
  ]);

  return diffDocxFingerprints(baseFingerprint, draftFingerprint);
}

async function preparePublicationBlob(
  draft: {
    content: string;
    contentFormat: string;
    artifactSha256?: string | null;
    artifactSizeBytes?: number | null;
    artifactMimeType?: string | null;
  }
): Promise<{ contentBuffer: Buffer; mimeType: string }> {
  if (
    draft.artifactSha256 &&
    draft.artifactSizeBytes !== null &&
    draft.artifactSizeBytes !== undefined &&
    draft.artifactMimeType === WORD_MIME_TYPE
  ) {
    return {
      contentBuffer: await streamToBuffer(await getBlob(draft.artifactSha256)),
      mimeType: WORD_MIME_TYPE,
    };
  }

  return {
    contentBuffer: Buffer.from(draft.content, "utf8"),
    mimeType: draft.contentFormat === "markdown" ? "text/markdown" : "text/plain",
  };
}

async function publishApprovedProposedChange(
  tx: PublishTransaction,
  draft: {
    id: string;
    workspaceId: string;
    documentId: string;
    content: string;
    contentFormat: string;
    artifactSha256: string | null;
    artifactSizeBytes: number | null;
    artifactMimeType: string | null;
    document: { title: string };
  },
  publication: {
    actorId: string;
    ip: string | undefined;
    userAgent: string | undefined;
    sha256: string;
    sizeBytes: number;
    mimeType: string;
  }
) {
  await lockDocumentForUpdate(tx, draft.workspaceId, draft.documentId);

  // Stake the publish claim before doing any work. A concurrent approval blocks on this row,
  // re-evaluates the predicate against the committed status, matches nothing, and aborts.
  const closedAt = new Date();
  const claimed = await tx.documentDraft.updateMany({
    where: {
      id: draft.id,
      status: { notIn: ["published", "abandoned"] },
    },
    data: {
      status: "published",
      closedAt,
    },
  });

  if (claimed.count === 0) {
    throw new ConflictError("Proposed change has already been published");
  }

  const latestVersion = await tx.documentVersion.aggregate({
    where: {
      documentId: draft.documentId,
      workspaceId: draft.workspaceId,
    },
    _max: { version: true },
  });
  const nextVersion = (latestVersion._max.version ?? 0) + 1;

  const blob = await tx.blob.upsert({
    where: { sha256: publication.sha256 },
    update: {},
    create: {
      sha256: publication.sha256,
      sizeBytes: publication.sizeBytes,
      storageKey: publication.sha256,
    },
  });

  const publishedVersion = await tx.documentVersion.create({
    data: {
      workspaceId: draft.workspaceId,
      documentId: draft.documentId,
      version: nextVersion,
      blobId: blob.id,
      sha256: publication.sha256,
      sizeBytes: publication.sizeBytes,
      mimeType: publication.mimeType,
      originalFilename: publicationFilenameFromTitle(
        draft.document.title,
        nextVersion,
        publication.mimeType
      ),
      createdById: publication.actorId,
    },
  });

  await createSearchIndexJob(tx, publishedVersion);

  await tx.auditLog.create({
    data: {
      workspaceId: draft.workspaceId,
      actorId: publication.actorId,
      action: "proposed_change.published",
      entityType: "proposed_change",
      entityId: draft.id,
      ip: publication.ip,
      userAgent: publication.userAgent,
      metadata: {
        documentId: draft.documentId,
        draftId: draft.id,
        versionId: publishedVersion.id,
        version: publishedVersion.version,
        sha256: publication.sha256,
        sizeBytes: publication.sizeBytes,
        mimeType: publication.mimeType,
        originalFilename: publishedVersion.originalFilename,
        closedAt: closedAt.toISOString(),
      },
    },
  });

  return publishedVersion;
}

// --- List documents ---

router.get("/", async (req, res) => {
  const { limit, offset } = parsePagination(req);

  const documents = await prisma.document.findMany({
    where: {
      workspaceId: req.membership!.workspaceId,
      archivedAt: null,
    },
    include: {
      versions: {
        orderBy: { version: "desc" },
        take: 1,
        include: {
          search: {
            select: {
              status: true,
              indexedAt: true,
              error: true,
            },
          },
        },
      },
      drafts: {
        where: { status: { in: ["in_review", "changes_requested"] } },
        select: { id: true, status: true },
        orderBy: { proposedAt: "desc" as const },
        take: 1,
      },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    skip: offset,
  });

  res.json({
    ok: true,
    data: {
      pagination: {
        limit,
        offset,
        nextOffset: documents.length === limit ? offset + limit : null,
      },
      documents: documents.map((document) => {
        const openProposal = document.drafts[0];
        return {
          id: document.id,
          workspaceId: document.workspaceId,
          title: document.title,
          createdAt: document.createdAt.toISOString(),
          latestVersion: document.versions[0]
            ? formatVersion(document.versions[0])
            : null,
          openProposedChange: openProposal
            ? { id: openProposal.id, status: PROPOSAL_WIRE_STATUS[openProposal.status] ?? openProposal.status }
            : null,
        };
      }),
    },
  });
});

// --- Create document ---

router.post("/", uploadSingleFile, async (req, res) => {
  const title = getStringField(req.body.title)?.trim();

  if (!title) {
    throw new ValidationError("Document title is required");
  }

  const file = requireUploadedFile(req);
  await assertSupportedSourceUpload(file);
  const { sha256, sizeBytes, mimeType } = await ingestUploadedFile(file);

  const result = await prisma.$transaction(async (tx) => {
    const audit = auditRequestMetadata(req);
    const blob = await tx.blob.upsert({
      where: { sha256 },
      update: {},
      create: {
        sha256,
        sizeBytes,
        storageKey: sha256,
      },
    });

    const document = await tx.document.create({
      data: {
        workspaceId: req.membership!.workspaceId,
        title,
        createdById: req.user!.id,
      },
    });

    const version = await tx.documentVersion.create({
      data: {
        workspaceId: req.membership!.workspaceId,
        documentId: document.id,
        version: 1,
        blobId: blob.id,
        sha256,
        sizeBytes,
        mimeType,
        originalFilename: file.originalname,
        createdById: req.user!.id,
      },
    });

    await createSearchIndexJob(tx, version);

    await tx.auditLog.create({
      data: {
        workspaceId: req.membership!.workspaceId,
        actorId: req.user!.id,
        action: "document.created",
        entityType: "document",
        entityId: document.id,
        ip: audit.ip,
        userAgent: audit.userAgent,
        metadata: {
          title: document.title,
          versionId: version.id,
          version: version.version,
          sha256,
          sizeBytes,
          mimeType,
          originalFilename: version.originalFilename,
        },
      },
    });

    return { document, version };
  });

  res.status(201).json({
    ok: true,
    data: {
      document: {
        id: result.document.id,
        workspaceId: result.document.workspaceId,
        title: result.document.title,
        createdAt: result.document.createdAt.toISOString(),
      },
      version: formatVersion(result.version),
    },
  });
});

// --- Search documents ---

router.get("/search", async (req, res) => {
  const query = getStringField(req.query.q)?.trim();
  const { limit, offset } = parsePagination(req);

  if (!query) {
    throw new ValidationError("Search query is required");
  }

  type SearchMatch = {
    documentId: string;
    documentWorkspaceId: string;
    documentTitle: string;
    documentCreatedAt: Date;
    versionId: string;
    versionNumber: number;
    versionSha256: string;
    versionSizeBytes: number;
    versionMimeType: string;
    versionOriginalFilename: string | null;
    versionCreatedAt: Date;
    searchStatus: string;
    searchIndexedAt: Date;
    searchError: string | null;
    snippet: string | null;
  };

  const matches = await prisma.$queryRaw<SearchMatch[]>`
    WITH search_query AS (
      SELECT websearch_to_tsquery(${SEARCH_TEXT_CONFIG}::regconfig, ${query}) AS q
    ),
    matching_versions AS (
      -- These two UNION arms are the indexable equivalent of titleVector @@ q OR contentVector @@ q.
      SELECT dv."id" AS "versionId"
      FROM "Document" d
      JOIN "DocumentVersion" dv ON dv."documentId" = d."id"
      WHERE d."workspaceId" = ${req.membership!.workspaceId}
        AND d."archivedAt" IS NULL
        AND d."titleVector" @@ websearch_to_tsquery(${SEARCH_TEXT_CONFIG}::regconfig, ${query})
      UNION
      SELECT ds."versionId"
      FROM "DocumentSearch" ds
      WHERE ds."workspaceId" = ${req.membership!.workspaceId}
        AND ds."status" = 'indexed'
        AND ds."contentVector" @@ websearch_to_tsquery(${SEARCH_TEXT_CONFIG}::regconfig, ${query})
    ),
    ranked AS (
      SELECT
        d."id" AS "documentId",
        d."workspaceId" AS "documentWorkspaceId",
        d."title" AS "documentTitle",
        d."createdAt" AS "documentCreatedAt",
        dv."id" AS "versionId",
        dv."version" AS "versionNumber",
        dv."sha256" AS "versionSha256",
        dv."sizeBytes" AS "versionSizeBytes",
        dv."mimeType" AS "versionMimeType",
        dv."originalFilename" AS "versionOriginalFilename",
        dv."createdAt" AS "versionCreatedAt",
        ds."status" AS "searchStatus",
        ds."indexedAt" AS "searchIndexedAt",
        ds."error" AS "searchError",
        -- A title match is five times as influential as a body match for result ordering.
        ts_rank(d."titleVector", search_query.q) * 5
          + ts_rank(ds."contentVector", search_query.q) AS "rank",
        ts_headline(
          ${SEARCH_TEXT_CONFIG}::regconfig,
          concat('Title: ', d."title", E'\\n', coalesce(ds."plainText", '')),
          search_query.q,
          ${SEARCH_HEADLINE_OPTIONS}
        ) AS "snippet"
      FROM "DocumentSearch" ds
      JOIN matching_versions mv ON mv."versionId" = ds."versionId"
      JOIN "DocumentVersion" dv ON dv."id" = ds."versionId"
      JOIN "Document" d ON d."id" = dv."documentId"
      CROSS JOIN search_query
      WHERE ds."workspaceId" = ${req.membership!.workspaceId}
        AND ds."status" = 'indexed'
        AND d."archivedAt" IS NULL
    ),
    deduplicated AS (
      SELECT DISTINCT ON ("documentId") *
      FROM ranked
      ORDER BY "documentId", "rank" DESC, "versionNumber" DESC
    )
    SELECT *
    FROM deduplicated
    ORDER BY "rank" DESC, "versionNumber" DESC, "documentId"
    LIMIT ${limit}
    OFFSET ${offset}
  `;
  const pendingIndexing = await prisma.documentSearch.count({
    where: {
      workspaceId: req.membership!.workspaceId,
      status: "pending",
    },
  });

  res.json({
    ok: true,
    data: {
      pagination: {
        limit,
        offset,
        nextOffset: matches.length === limit ? offset + limit : null,
      },
      pendingIndexing,
      results: matches.map((match) => ({
        document: {
          id: match.documentId,
          workspaceId: match.documentWorkspaceId,
          title: match.documentTitle,
          createdAt: match.documentCreatedAt.toISOString(),
        },
        version: formatVersion({
          id: match.versionId,
          version: match.versionNumber,
          sha256: match.versionSha256,
          sizeBytes: match.versionSizeBytes,
          mimeType: match.versionMimeType,
          originalFilename: match.versionOriginalFilename,
          createdAt: match.versionCreatedAt,
          createdBy: null,
          search: {
            status: match.searchStatus,
            indexedAt: match.searchIndexedAt,
            error: match.searchError,
          },
        }),
        search: {
          status: match.searchStatus,
          indexedAt: match.searchIndexedAt.toISOString(),
          snippet: match.snippet,
        },
      })),
    },
  });
});

// --- Create document draft ---

router.post("/:documentId/drafts", async (req, res) => {
  const documentId = getRouteParam(req, "documentId");

  const document = await prisma.document.findFirst({
    where: {
      id: documentId,
      workspaceId: req.membership!.workspaceId,
      archivedAt: null,
    },
    include: {
      versions: {
        orderBy: { version: "desc" },
        take: 1,
      },
    },
  });

  if (!document) {
    throw new NotFoundError("Document not found");
  }

  const latestVersion = document.versions[0];

  if (!latestVersion) {
    throw new ValidationError("Document has no published versions");
  }

  // "A draft in progress" and "a proposal awaiting review" are now the same query — the
  // partial unique index guarantees at most one row per document with one of these statuses.
  const activeDraft = await prisma.documentDraft.findFirst({
    where: {
      documentId: document.id,
      workspaceId: req.membership!.workspaceId,
      status: { in: ["draft", "in_review", "changes_requested"] },
    },
    select: { id: true, status: true },
  });

  if (activeDraft?.status === "draft") {
    throw new ConflictError("A draft is already in progress for this document");
  }

  if (activeDraft) {
    throw new ValidationError("A proposed change is already awaiting review");
  }

  let content: string;
  let contentFormat: "plain" | "markdown" = "plain";

  content = await readTextVersion(latestVersion);
  contentFormat = latestVersion.mimeType === "text/plain" ? "plain" : "markdown";

  const audit = auditRequestMetadata(req);

  const draft = await prisma.$transaction(async (tx) => {
    await lockDocumentForUpdate(tx, req.membership!.workspaceId, document.id);

    const lockedActiveDraft = await tx.documentDraft.findFirst({
      where: {
        documentId: document.id,
        workspaceId: req.membership!.workspaceId,
        status: { in: ["draft", "in_review", "changes_requested"] },
      },
      select: { id: true, status: true },
    });

    if (lockedActiveDraft?.status === "draft") {
      throw new ConflictError("A draft is already in progress for this document");
    }

    if (lockedActiveDraft) {
      throw new ValidationError("A proposed change is already awaiting review");
    }

    const lockedLatestVersion = await tx.documentVersion.findFirst({
      where: {
        documentId: document.id,
        workspaceId: req.membership!.workspaceId,
      },
      orderBy: { version: "desc" },
      select: { id: true },
    });

    if (!lockedLatestVersion || lockedLatestVersion.id !== latestVersion.id) {
      throw new ConflictError("The document changed while creating the draft; please try again");
    }

    const created = await tx.documentDraft.create({
      data: {
        workspaceId: req.membership!.workspaceId,
        documentId: document.id,
        baseVersionId: latestVersion.id,
        title: document.title,
        content,
        contentFormat,
        status: "draft",
        editorKey: latestVersion.mimeType === WORD_MIME_TYPE
          ? draftEditorKey(latestVersion.id, req.user!.id)
          : null,
        artifactSha256: latestVersion.mimeType === WORD_MIME_TYPE ? latestVersion.sha256 : null,
        artifactSizeBytes: latestVersion.mimeType === WORD_MIME_TYPE ? latestVersion.sizeBytes : null,
        artifactMimeType: latestVersion.mimeType === WORD_MIME_TYPE ? WORD_MIME_TYPE : null,
        artifactOriginalFilename: latestVersion.mimeType === WORD_MIME_TYPE ? latestVersion.originalFilename : null,
        createdById: req.user!.id,
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: req.membership!.workspaceId,
        actorId: req.user!.id,
        action: "document_draft.created",
        entityType: "document_draft",
        entityId: created.id,
        ip: audit.ip,
        userAgent: audit.userAgent,
        metadata: {
          documentId: document.id,
          title: created.title,
          baseVersionId: latestVersion.id,
          baseVersion: latestVersion.version,
        },
      },
    });

    return created;
  });

  res.status(201).json({
    ok: true,
    data: {
      draft: formatDraft(draft),
    },
  });
});

// --- Draft write authorization ---

type DraftOwnership = {
  status: string;
  createdById: string | null;
};

function isDraftAuthor(draft: DraftOwnership, req: Request) {
  return draft.createdById === req.user!.id || req.membership!.role === "admin";
}

// A draft accepts writes while it is still a draft, or while a reviewer has sent it back
// for revision. Anything awaiting review or published is frozen.
function isDraftInWritableState(draft: DraftOwnership) {
  return draft.status === "draft" || draft.status === "changes_requested";
}

function canWriteDraft(draft: DraftOwnership, req: Request) {
  return isDraftAuthor(draft, req) && isDraftInWritableState(draft);
}

function assertDraftWritable(draft: DraftOwnership, req: Request) {
  if (!isDraftAuthor(draft, req)) {
    throw new ForbiddenError("Only the draft author or an admin can edit this draft");
  }

  if (!isDraftInWritableState(draft)) {
    throw new ValidationError("Only draft changes can be updated");
  }
}

// --- Native DOCX editor configuration ---

router.get("/:documentId/drafts/:draftId/editor-config", async (req, res) => {
  const documentId = getRouteParam(req, "documentId");
  const draftId = getRouteParam(req, "draftId");
  const draft = await prisma.documentDraft.findFirst({
    where: {
      id: draftId,
      documentId,
      workspaceId: req.membership!.workspaceId,
      document: { archivedAt: null },
    },
    select: {
      id: true,
      editorKey: true,
      title: true,
      status: true,
      createdById: true,
      artifactMimeType: true,
      artifactOriginalFilename: true,
    },
  });

  if (!draft) throw new NotFoundError("Draft not found");
  if (draft.artifactMimeType !== WORD_MIME_TYPE) {
    throw new ValidationError("Only DOCX drafts can be opened in the native editor");
  }

  res.json({
    ok: true,
    data: {
      editor: buildDraftEditorConfig({
        draft,
        user: { id: req.user!.id, name: req.user!.email },
        // Reviewers still get a config so they can read the DOCX; only the author edits.
        editable: canWriteDraft(draft, req),
      }),
    },
  });
});

router.post("/:documentId/drafts/:draftId/editor/force-save", async (req, res) => {
  const documentId = getRouteParam(req, "documentId");
  const draftId = getRouteParam(req, "draftId");
  const draft = await prisma.documentDraft.findFirst({
    where: {
      id: draftId,
      documentId,
      workspaceId: req.membership!.workspaceId,
      document: { archivedAt: null },
    },
    select: {
      editorKey: true,
      artifactMimeType: true,
      status: true,
      createdById: true,
    },
  });

  if (!draft) throw new NotFoundError("Draft not found");
  if (draft.artifactMimeType !== WORD_MIME_TYPE) {
    throw new ValidationError("Only DOCX drafts support native editor saving");
  }

  assertDraftWritable(draft, req);

  await forceSaveDraftEditor(draft);
  res.json({ ok: true, data: { requested: true } });
});

// --- Get document draft ---

router.get("/:documentId/drafts/:draftId", async (req, res) => {
  const documentId = getRouteParam(req, "documentId");
  const draftId = getRouteParam(req, "draftId");

  const draft = await prisma.documentDraft.findFirst({
    where: {
      id: draftId,
      documentId,
      workspaceId: req.membership!.workspaceId,
      document: {
        archivedAt: null,
      },
    },
  });

  if (!draft) {
    throw new NotFoundError("Draft not found");
  }

  res.json({
    ok: true,
    data: {
      draft: formatDraft(draft),
    },
  });
});

// --- Discard document draft ---

// Without this an unproposed draft has no exit: it cannot be proposed if it changes no text,
// and it holds the one active slot per document. Proposals are closed via /abandon instead.
router.post("/:documentId/drafts/:draftId/discard", async (req, res) => {
  const documentId = getRouteParam(req, "documentId");
  const draftId = getRouteParam(req, "draftId");

  const existing = await prisma.documentDraft.findFirst({
    where: {
      id: draftId,
      documentId,
      workspaceId: req.membership!.workspaceId,
      document: { archivedAt: null },
    },
    select: { id: true, status: true, createdById: true },
  });

  if (!existing) {
    throw new NotFoundError("Draft not found");
  }

  if (!isDraftAuthor(existing, req)) {
    throw new ForbiddenError("Only the draft author or an admin can discard this draft");
  }

  if (existing.status !== "draft") {
    throw new ValidationError("Only an unproposed draft can be discarded");
  }

  const audit = auditRequestMetadata(req);
  const discarded = await prisma.$transaction(async (tx) => {
    const closedAt = new Date();
    const claimed = await tx.documentDraft.updateMany({
      where: { id: existing.id, status: "draft" },
      data: { status: "abandoned", closedAt },
    });

    if (claimed.count === 0) {
      throw new ConflictError("Draft is no longer discardable");
    }

    await tx.auditLog.create({
      data: {
        workspaceId: req.membership!.workspaceId,
        actorId: req.user!.id,
        action: "document_draft.discarded",
        entityType: "document_draft",
        entityId: existing.id,
        ip: audit.ip,
        userAgent: audit.userAgent,
        metadata: { documentId, draftId: existing.id, closedAt: closedAt.toISOString() },
      },
    });

    return tx.documentDraft.findUniqueOrThrow({ where: { id: existing.id } });
  });

  res.json({
    ok: true,
    data: {
      draft: formatDraft(discarded),
    },
  });
});

// --- Update document draft ---

const updateDraftSchema = z
  .object({
    content: z.string().refine((value) => value.trim().length > 0, "Draft content is required"),
  })
  .strict();

router.patch("/:documentId/drafts/:draftId", async (req, res) => {
  const documentId = getRouteParam(req, "documentId");
  const draftId = getRouteParam(req, "draftId");
  const parsed = updateDraftSchema.safeParse(req.body);

  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0].message);
  }

  const existing = await prisma.documentDraft.findFirst({
    where: {
      id: draftId,
      documentId,
      workspaceId: req.membership!.workspaceId,
      document: {
        archivedAt: null,
      },
    },
  });

  if (!existing) {
    throw new NotFoundError("Draft not found");
  }

  if (existing.artifactMimeType === WORD_MIME_TYPE) {
    throw new ValidationError("Word drafts are edited in the native editor, not by content patch");
  }

  const isRequestedRevision = existing.status === "changes_requested";

  assertDraftWritable(existing, req);

  const audit = auditRequestMetadata(req);
  const draft = await prisma.$transaction(async (tx) => {
    const updated = await tx.documentDraft.update({
      where: { id: existing.id },
      data: {
        content: parsed.data.content,
        ...(isRequestedRevision ? { status: "in_review" } : {}),
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: req.membership!.workspaceId,
        actorId: req.user!.id,
        action: isRequestedRevision ? "proposed_change.revised" : "document_draft.updated",
        entityType: isRequestedRevision ? "proposed_change" : "document_draft",
        entityId: existing.id,
        ip: audit.ip,
        userAgent: audit.userAgent,
        metadata: {
          documentId,
          draftId: existing.id,
          previousStatus: PROPOSAL_WIRE_STATUS[existing.status] ?? existing.status,
          status: isRequestedRevision ? "open" : existing.status,
        },
      },
    });

    return updated;
  });

  res.json({
    ok: true,
    data: {
      draft: formatDraft(draft),
    },
  });
});

// --- Submit draft as proposed change ---

const proposeDraftSchema = z.object({
  summary: z.string().trim().min(1, "Proposed change summary is required").optional(),
});

router.post("/:documentId/drafts/:draftId/propose", async (req, res) => {
  const documentId = getRouteParam(req, "documentId");
  const draftId = getRouteParam(req, "draftId");
  const parsed = proposeDraftSchema.safeParse(req.body);

  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0].message);
  }

  const existing = await prisma.documentDraft.findFirst({
    where: {
      id: draftId,
      documentId,
      workspaceId: req.membership!.workspaceId,
      document: {
        archivedAt: null,
      },
    },
    include: {
      baseVersion: true,
    },
  });

  if (!existing) {
    throw new NotFoundError("Draft not found");
  }

  if (!isDraftAuthor(existing, req)) {
    throw new ForbiddenError("Only the draft author or an admin can propose this draft");
  }

  if (existing.status !== "draft") {
    throw new ValidationError("Only draft changes can be proposed");
  }

  // Applies to every format: for txt/md an identical body means nothing changed at all, and
  // for docx (compared via its extracted markdown) it means the change is formatting-only —
  // either way there is nothing for a reviewer to see in the redline.
  const baseContentForCompare = await readReviewBaseContent(existing.baseVersion);
  if (baseContentForCompare === existing.content) {
    throw new ValidationError("This change modifies no reviewable text");
  }

  const audit = auditRequestMetadata(req);
  const proposedChange = await prisma.$transaction(async (tx) => {
    await lockDocumentForUpdate(tx, req.membership!.workspaceId, documentId);

    const currentDraft = await tx.documentDraft.findFirst({
      where: {
        id: existing.id,
        documentId,
        workspaceId: req.membership!.workspaceId,
        status: "draft",
      },
    });

    if (!currentDraft) {
      throw new ValidationError("Only draft changes can be proposed");
    }

    // No separate "another proposal is active" check needed — the partial unique index makes
    // it impossible for a second row to be active for this document while this one is.
    const opened = await tx.documentDraft.update({
      where: { id: currentDraft.id },
      data: {
        status: "in_review",
        summary: parsed.data.summary ?? null,
        proposedById: req.user!.id,
        proposedAt: new Date(),
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: req.membership!.workspaceId,
        actorId: req.user!.id,
        action: "proposed_change.opened",
        entityType: "proposed_change",
        entityId: opened.id,
        ip: audit.ip,
        userAgent: audit.userAgent,
        metadata: {
          documentId,
          draftId: currentDraft.id,
          baseVersionId: currentDraft.baseVersionId,
          summary: opened.summary,
        },
      },
    });

    return opened;
  });

  res.status(201).json({
    ok: true,
    data: {
      proposedChange: formatProposedChange(proposedChange),
    },
  });
});

// --- Abandon proposed change ---

router.post("/:documentId/proposed-changes/:proposedChangeId/abandon", async (req, res) => {
  const documentId = getRouteParam(req, "documentId");
  const proposedChangeId = getRouteParam(req, "proposedChangeId");

  // status !== "draft" means it's actually been proposed at some point — a plain draft has
  // never had a "proposed change" identity, matching the old behavior of ProposedChange
  // simply not existing yet for it.
  const proposedChange = await prisma.documentDraft.findFirst({
    where: {
      id: proposedChangeId,
      documentId,
      workspaceId: req.membership!.workspaceId,
      document: { archivedAt: null },
      status: { not: "draft" },
    },
    select: { id: true, status: true, proposedById: true },
  });

  if (!proposedChange) {
    throw new NotFoundError("Proposed change not found");
  }

  if (proposedChange.status === "published") {
    throw new ValidationError("Published proposed changes cannot be abandoned");
  }

  if (proposedChange.status === "abandoned") {
    throw new ValidationError("Proposed change is already closed");
  }

  if (proposedChange.proposedById !== req.user!.id && req.membership!.role !== "admin") {
    throw new ForbiddenError("Only the proposer or an admin can abandon a proposed change");
  }

  const audit = auditRequestMetadata(req);

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.documentDraft.update({
      where: { id: proposedChange.id },
      data: { status: "abandoned", closedAt: new Date() },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: req.membership!.workspaceId,
        actorId: req.user!.id,
        action: "proposed_change.abandoned",
        entityType: "proposed_change",
        entityId: proposedChange.id,
        ip: audit.ip,
        userAgent: audit.userAgent,
        metadata: { documentId },
      },
    });

    return result;
  });

  res.json({
    ok: true,
    data: {
      proposedChange: formatProposedChange(updated),
    },
  });
});

// --- Withdraw proposed change back to draft ---

// The authorship counterpart to a reviewer's "request changes": it returns the work to the
// author for editing without recording a review verdict against anyone. Abandon closes a
// proposal for good; this one keeps it alive so it can be re-proposed.
router.post("/:documentId/proposed-changes/:proposedChangeId/withdraw", async (req, res) => {
  const documentId = getRouteParam(req, "documentId");
  const proposedChangeId = getRouteParam(req, "proposedChangeId");

  const proposedChange = await prisma.documentDraft.findFirst({
    where: {
      id: proposedChangeId,
      documentId,
      workspaceId: req.membership!.workspaceId,
      document: { archivedAt: null },
      status: { not: "draft" },
    },
    select: { id: true, status: true, proposedById: true },
  });

  if (!proposedChange) {
    throw new NotFoundError("Proposed change not found");
  }

  if (proposedChange.status === "published") {
    throw new ValidationError("Published proposed changes cannot be withdrawn");
  }

  if (proposedChange.status === "abandoned") {
    throw new ValidationError("Proposed change is already closed");
  }

  if (proposedChange.proposedById !== req.user!.id && req.membership!.role !== "admin") {
    throw new ForbiddenError("Only the proposer or an admin can withdraw a proposed change");
  }

  const audit = auditRequestMetadata(req);

  const updated = await prisma.$transaction(async (tx) => {
    // Conditional so a review landing concurrently cannot be silently undone.
    const claimed = await tx.documentDraft.updateMany({
      where: { id: proposedChange.id, status: { in: ["in_review", "changes_requested"] } },
      data: { status: "draft", proposedAt: null, closedAt: null },
    });

    if (claimed.count === 0) {
      throw new ConflictError("Proposed change is no longer open");
    }

    await tx.auditLog.create({
      data: {
        workspaceId: req.membership!.workspaceId,
        actorId: req.user!.id,
        action: "proposed_change.withdrawn",
        entityType: "proposed_change",
        entityId: proposedChange.id,
        ip: audit.ip,
        userAgent: audit.userAgent,
        metadata: { documentId, previousStatus: proposedChange.status },
      },
    });

    return tx.documentDraft.findUniqueOrThrow({ where: { id: proposedChange.id } });
  });

  res.json({
    ok: true,
    data: {
      draft: formatDraft(updated),
    },
  });
});

// --- List tasks ---

router.get("/:documentId/tasks", async (req, res) => {
  const documentId = getRouteParam(req, "documentId");

  const tasks = await prisma.task.findMany({
    where: {
      documentId,
      workspaceId: req.membership!.workspaceId,
      document: { archivedAt: null },
    },
    include: {
      assignee: { select: { id: true, email: true, firstName: true, lastName: true } },
      createdBy: { select: { id: true, email: true, firstName: true, lastName: true } },
    },
    orderBy: [{ status: "asc" }, { createdAt: "asc" }],
  });

  res.json({
    ok: true,
    data: {
      tasks: tasks.map((task) => ({
        id: task.id,
        documentId: task.documentId,
        title: task.title,
        status: task.status,
        createdAt: task.createdAt.toISOString(),
        completedAt: task.completedAt?.toISOString() ?? null,
        assignee: task.assignee ? formatUserRef(task.assignee) : null,
        createdBy: task.createdBy ? formatUserRef(task.createdBy) : null,
      })),
    },
  });
});

// --- Create task ---

const createTaskSchema = z.object({
  title: z.string().trim().min(1, "Task title is required").max(500, "Task title too long"),
  assigneeId: z.string().min(1, "Assignee is required"),
});

router.post("/:documentId/tasks", async (req, res) => {
  const documentId = getRouteParam(req, "documentId");

  const document = await prisma.document.findFirst({
    where: {
      id: documentId,
      workspaceId: req.membership!.workspaceId,
      archivedAt: null,
    },
    select: { id: true },
  });

  if (!document) {
    throw new NotFoundError("Document not found");
  }

  const parsed = createTaskSchema.safeParse(req.body);

  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0].message);
  }

  const { title, assigneeId } = parsed.data;

  const assigneeMembership = await prisma.membership.findUnique({
    where: { workspaceId_userId: { workspaceId: req.membership!.workspaceId, userId: assigneeId } },
    select: { userId: true },
  });

  if (!assigneeMembership) {
    throw new ValidationError("Assignee is not a member of this workspace");
  }

  const audit = auditRequestMetadata(req);

  const task = await prisma.$transaction(async (tx) => {
    const created = await tx.task.create({
      data: {
        workspaceId: req.membership!.workspaceId,
        documentId: document.id,
        title,
        assigneeId,
        createdById: req.user!.id,
        status: "open",
      },
      include: {
        assignee: { select: { id: true, email: true, firstName: true, lastName: true } },
        createdBy: { select: { id: true, email: true, firstName: true, lastName: true } },
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: req.membership!.workspaceId,
        actorId: req.user!.id,
        action: "document_task.created",
        entityType: "task",
        entityId: created.id,
        ip: audit.ip,
        userAgent: audit.userAgent,
        metadata: { documentId, title, assigneeId },
      },
    });

    return created;
  });

  res.status(201).json({
    ok: true,
    data: {
      task: {
        id: task.id,
        documentId: task.documentId,
        title: task.title,
        status: task.status,
        createdAt: task.createdAt.toISOString(),
        completedAt: null,
        assignee: task.assignee ? formatUserRef(task.assignee) : null,
        createdBy: task.createdBy ? formatUserRef(task.createdBy) : null,
      },
    },
  });
});

// --- Complete task ---

router.patch("/:documentId/tasks/:taskId", async (req, res) => {
  const documentId = getRouteParam(req, "documentId");
  const taskId = getRouteParam(req, "taskId");

  const task = await prisma.task.findFirst({
    where: {
      id: taskId,
      documentId,
      workspaceId: req.membership!.workspaceId,
      document: { archivedAt: null },
    },
    select: { id: true, status: true, assigneeId: true, createdById: true },
  });

  if (!task) {
    throw new NotFoundError("Task not found");
  }

  if (
    task.assigneeId !== req.user!.id &&
    task.createdById !== req.user!.id &&
    req.membership!.role !== "admin"
  ) {
    throw new ForbiddenError("Only the assignee, the task's creator, or an admin can complete this task");
  }

  if (task.status === "done") {
    throw new ValidationError("Task is already done");
  }

  const audit = auditRequestMetadata(req);
  const completedAt = new Date();

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.task.update({
      where: { id: task.id },
      data: { status: "done", completedAt },
      include: {
        assignee: { select: { id: true, email: true, firstName: true, lastName: true } },
        createdBy: { select: { id: true, email: true, firstName: true, lastName: true } },
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: req.membership!.workspaceId,
        actorId: req.user!.id,
        action: "document_task.completed",
        entityType: "task",
        entityId: task.id,
        ip: audit.ip,
        userAgent: audit.userAgent,
        metadata: { documentId },
      },
    });

    return result;
  });

  res.json({
    ok: true,
    data: {
      task: {
        id: updated.id,
        documentId: updated.documentId,
        title: updated.title,
        status: updated.status,
        createdAt: updated.createdAt.toISOString(),
        completedAt: updated.completedAt?.toISOString() ?? null,
        assignee: updated.assignee ? formatUserRef(updated.assignee) : null,
        createdBy: updated.createdBy ? formatUserRef(updated.createdBy) : null,
      },
    },
  });
});

// --- Get proposed change detail ---

router.get("/:documentId/proposed-changes/:proposedChangeId", async (req, res) => {
  const documentId = getRouteParam(req, "documentId");
  const proposedChangeId = getRouteParam(req, "proposedChangeId");

  const proposedChange = await prisma.documentDraft.findFirst({
    where: {
      id: proposedChangeId,
      documentId,
      workspaceId: req.membership!.workspaceId,
      document: {
        archivedAt: null,
      },
      status: { not: "draft" },
    },
    include: {
      baseVersion: {
        include: {
          search: {
            select: {
              status: true,
              indexedAt: true,
              error: true,
              plainText: true,
            },
          },
        },
      },
      reviews: {
        orderBy: { createdAt: "asc" },
        include: {
          reviewer: { select: { id: true, email: true, firstName: true, lastName: true } },
        },
      },
      lineComments: {
        orderBy: { createdAt: "asc" },
        include: {
          author: { select: { id: true, email: true, firstName: true, lastName: true } },
        },
      },
    },
  });

  if (!proposedChange) {
    throw new NotFoundError("Proposed change not found");
  }

  const baseContent = await readReviewBaseContent(proposedChange.baseVersion);
  const draftContent = proposedChange.content;
  const docxHiddenChanges = await computeDocxHiddenChanges(proposedChange, proposedChange.baseVersion);

  res.json({
    ok: true,
    data: {
      proposedChange: formatProposedChange(proposedChange),
      draft: formatDraftMetadata(proposedChange),
      baseVersion: formatVersion(proposedChange.baseVersion),
      baseContent,
      draftContent,
      diff: createLineDiff(baseContent, draftContent),
      docxHiddenChanges,
      reviews: proposedChange.reviews.map(formatReview),
      comments: proposedChange.lineComments.map((c) => ({
        id: c.id,
        diffLineIndex: c.diffLineIndex,
        body: c.body,
        createdAt: c.createdAt.toISOString(),
        author: c.author ? formatUserRef(c.author) : null,
      })),
    },
  });
});

// --- Add line comment ---

const createLineCommentSchema = z.object({
  diffLineIndex: z.number().int().min(0),
  body: z.string().trim().min(1, "Comment body is required"),
});

router.post("/:documentId/proposed-changes/:proposedChangeId/comments", async (req, res) => {
  const documentId = getRouteParam(req, "documentId");
  const proposedChangeId = getRouteParam(req, "proposedChangeId");
  const parsed = createLineCommentSchema.safeParse(req.body);

  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0].message);
  }

  const existing = await prisma.documentDraft.findFirst({
    where: {
      id: proposedChangeId,
      documentId,
      workspaceId: req.membership!.workspaceId,
      document: { archivedAt: null },
      status: { not: "draft" },
    },
    include: {
      baseVersion: true,
    },
  });

  if (!existing) {
    throw new NotFoundError("Proposed change not found");
  }

  if (existing.status === "published" || existing.status === "abandoned") {
    throw new ValidationError("Closed proposed changes cannot be commented on");
  }

  const baseContent = await readReviewBaseContent(existing.baseVersion);
  const diff = createLineDiff(baseContent, existing.content);

  if (diff.type === "too_large") {
    throw new ValidationError("This proposed change is too large to receive line comments");
  }

  if (parsed.data.diffLineIndex >= diff.lines.length) {
    throw new ValidationError("Comment line does not exist in this proposed change");
  }

  const audit = auditRequestMetadata(req);
  const comment = await prisma.$transaction(async (tx) => {
    const created = await tx.lineComment.create({
      data: {
        workspaceId: req.membership!.workspaceId,
        draftId: existing.id,
        authorId: req.user!.id,
        diffLineIndex: parsed.data.diffLineIndex,
        body: parsed.data.body,
      },
      include: { author: { select: { id: true, email: true, firstName: true, lastName: true } } },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: req.membership!.workspaceId,
        actorId: req.user!.id,
        action: "proposed_change.commented",
        entityType: "proposed_change",
        entityId: existing.id,
        ip: audit.ip,
        userAgent: audit.userAgent,
        metadata: { documentId, diffLineIndex: parsed.data.diffLineIndex },
      },
    });

    return created;
  });

  res.status(201).json({
    ok: true,
    data: {
      comment: {
        id: comment.id,
        diffLineIndex: comment.diffLineIndex,
        body: comment.body,
        createdAt: comment.createdAt.toISOString(),
        author: comment.author ? formatUserRef(comment.author) : null,
      },
    },
  });
});

// --- Review proposed change ---

const reviewProposedChangeSchema = z.object({
  state: z.enum(["approved", "changes_requested", "commented"]),
  body: z.string().optional(),
});

router.post("/:documentId/proposed-changes/:proposedChangeId/reviews", async (req, res) => {
  const documentId = getRouteParam(req, "documentId");
  const proposedChangeId = getRouteParam(req, "proposedChangeId");
  const parsed = reviewProposedChangeSchema.safeParse(req.body);

  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0].message);
  }

  const existing = await prisma.documentDraft.findFirst({
    where: {
      id: proposedChangeId,
      documentId,
      workspaceId: req.membership!.workspaceId,
      document: {
        archivedAt: null,
      },
      status: { not: "draft" },
    },
    include: {
      document: {
        select: {
          title: true,
        },
      },
    },
  });

  if (!existing) {
    throw new NotFoundError("Proposed change not found");
  }

  if (existing.status === "published" || existing.status === "abandoned") {
    throw new ValidationError("Closed proposed changes cannot be reviewed");
  }

  // A review is a verdict that gets recorded against a reviewer, so an author must not be able
  // to enter one on their own proposal — it would make the review history unreadable as
  // evidence of who actually scrutinised the change. Authors move their own work with the
  // authorship verbs instead: propose, withdraw, revise.
  if (parsed.data.state !== "commented" && existing.proposedById === req.user!.id) {
    throw new ValidationError(
      parsed.data.state === "approved"
        ? "You cannot approve your own proposed change"
        : "You cannot request changes on your own proposed change. Withdraw it to keep editing."
    );
  }

  let publication: { contentBuffer: Buffer; mimeType: string } | null = null;
  if (parsed.data.state === "approved") {
    publication = await preparePublicationBlob(existing);
  }
  const publicationHash = publication
    ? createHash("sha256").update(publication.contentBuffer).digest("hex")
    : null;

  if (publication && publicationHash && !(await blobExists(publicationHash))) {
    await putBlob(
      publicationHash,
      Readable.from(publication.contentBuffer),
      publication.contentBuffer.length,
      publication.mimeType
    );
  }

  const audit = auditRequestMetadata(req);
  const result = await prisma.$transaction(async (tx) => {
    // Lock first so the state re-read below is taken under the lock, not before it.
    await lockDocumentForUpdate(tx, req.membership!.workspaceId, documentId);

    const current = await tx.documentDraft.findFirst({
      where: {
        id: existing.id,
        workspaceId: req.membership!.workspaceId,
        documentId,
        status: { notIn: ["published", "abandoned"] },
        document: {
          archivedAt: null,
        },
      },
      include: {
        document: {
          select: {
            title: true,
          },
        },
      },
    });

    if (!current) {
      throw new ValidationError("Closed proposed changes cannot be reviewed");
    }

    const review = await tx.review.create({
      data: {
        workspaceId: req.membership!.workspaceId,
        draftId: current.id,
        reviewerId: req.user!.id,
        state: parsed.data.state,
        body: parsed.data.body ?? null,
      },
    });

    let publishedVersion: Awaited<ReturnType<typeof publishApprovedProposedChange>> | null = null;
    let newStatus = current.status;

    if (parsed.data.state === "approved") {
      publishedVersion = await publishApprovedProposedChange(tx, current, {
        actorId: req.user!.id,
        ip: audit.ip,
        userAgent: audit.userAgent,
        sha256: publicationHash!,
        sizeBytes: publication!.contentBuffer.length,
        mimeType: publication!.mimeType,
      });
      newStatus = "published";
    } else if (parsed.data.state === "changes_requested") {
      const updated = await tx.documentDraft.update({
        where: { id: current.id },
        data: { status: "changes_requested" },
      });
      newStatus = updated.status;
    }

    const proposedChangeStatus = PROPOSAL_WIRE_STATUS[newStatus] ?? newStatus;

    await tx.auditLog.create({
      data: {
        workspaceId: req.membership!.workspaceId,
        actorId: req.user!.id,
        action: "proposed_change.reviewed",
        entityType: "proposed_change",
        entityId: current.id,
        ip: audit.ip,
        userAgent: audit.userAgent,
        metadata: {
          documentId,
          reviewId: review.id,
          state: review.state,
          status: proposedChangeStatus,
          publishedVersionId: publishedVersion?.id ?? null,
        },
      },
    });

    return { review, proposedChangeStatus, publishedVersion };
  });

  res.status(201).json({
    ok: true,
    data: {
      review: formatReview(result.review),
      proposedChangeStatus: result.proposedChangeStatus,
      version: result.publishedVersion ? formatVersion(result.publishedVersion) : null,
    },
  });
});

// --- Get document detail ---

const renameDocumentSchema = z.object({
  title: z.string().trim().min(1, "Document title is required").max(200, "Document title too long"),
});

// --- Rename document ---

router.patch("/:documentId", async (req, res) => {
  const documentId = getRouteParam(req, "documentId");
  const parsed = renameDocumentSchema.safeParse(req.body);

  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0].message);
  }

  const existing = await prisma.document.findFirst({
    where: {
      id: documentId,
      workspaceId: req.membership!.workspaceId,
      archivedAt: null,
    },
    select: { id: true, workspaceId: true, title: true, createdAt: true },
  });

  if (!existing) {
    throw new NotFoundError("Document not found");
  }

  const audit = auditRequestMetadata(req);
  const document = await prisma.$transaction(async (tx) => {
    const updated = await tx.document.update({
      where: { id: existing.id },
      data: { title: parsed.data.title },
      select: { id: true, workspaceId: true, title: true, createdAt: true },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: req.membership!.workspaceId,
        actorId: req.user!.id,
        action: "document.renamed",
        entityType: "document",
        entityId: updated.id,
        ip: audit.ip,
        userAgent: audit.userAgent,
        metadata: {
          previousTitle: existing.title,
          title: updated.title,
        },
      },
    });

    return updated;
  });

  res.json({
    ok: true,
    data: {
      document: {
        id: document.id,
        workspaceId: document.workspaceId,
        title: document.title,
        createdAt: document.createdAt.toISOString(),
      },
    },
  });
});

// --- Archive document ---

router.delete("/:documentId", async (req, res) => {
  if (req.membership!.role !== "admin") {
    throw new ForbiddenError("Only admins can archive documents");
  }

  const documentId = getRouteParam(req, "documentId");

  const existing = await prisma.document.findFirst({
    where: {
      id: documentId,
      workspaceId: req.membership!.workspaceId,
      archivedAt: null,
    },
    select: { id: true, title: true },
  });

  if (!existing) {
    throw new NotFoundError("Document not found");
  }

  const audit = auditRequestMetadata(req);
  const archivedAt = new Date();

  await prisma.$transaction(async (tx) => {
    await lockDocumentForUpdate(tx, req.membership!.workspaceId, existing.id);

    const activeDraft = await tx.documentDraft.findFirst({
      where: {
        documentId: existing.id,
        workspaceId: req.membership!.workspaceId,
        status: { in: ["draft", "in_review", "changes_requested"] },
      },
      select: { id: true },
    });

    if (activeDraft) {
      throw new ConflictError("Cannot archive a document with an active draft or proposed change");
    }

    await tx.document.update({
      where: { id: existing.id },
      data: { archivedAt },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: req.membership!.workspaceId,
        actorId: req.user!.id,
        action: "document.archived",
        entityType: "document",
        entityId: existing.id,
        ip: audit.ip,
        userAgent: audit.userAgent,
        metadata: {
          title: existing.title,
          archivedAt: archivedAt.toISOString(),
        },
      },
    });
  });

  res.json({
    ok: true,
    data: {
      document: {
        id: existing.id,
        archivedAt: archivedAt.toISOString(),
      },
    },
  });
});

router.get("/:documentId", async (req, res) => {
  const documentId = getRouteParam(req, "documentId");

  const document = await prisma.document.findFirst({
    where: {
      id: documentId,
      workspaceId: req.membership!.workspaceId,
      archivedAt: null,
    },
    include: {
      versions: {
        orderBy: { version: "asc" },
        include: {
          createdBy: {
            select: { id: true, email: true, firstName: true, lastName: true },
          },
          search: {
            select: {
              status: true,
              indexedAt: true,
              error: true,
            },
          },
        },
      },
      // The partial unique index guarantees at most one row in these statuses, so an
      // unproposed draft and an open proposal are the same slot. Both are returned: without
      // the "draft" case an in-progress draft is invisible to the client while still
      // blocking new ones.
      drafts: {
        where: { status: { in: ["draft", "in_review", "changes_requested"] } },
        select: { id: true, status: true, createdById: true, updatedAt: true },
        take: 1,
      },
    },
  });

  if (!document) {
    throw new NotFoundError("Document not found");
  }

  const active = document.drafts[0];
  const openProposal = active && active.status !== "draft" ? active : undefined;
  const activeDraft = active && active.status === "draft" ? active : undefined;

  res.json({
    ok: true,
    data: {
      document: {
        id: document.id,
        workspaceId: document.workspaceId,
        title: document.title,
        createdAt: document.createdAt.toISOString(),
        versions: document.versions.map(formatVersion),
        openProposedChange: openProposal
          ? { id: openProposal.id, status: PROPOSAL_WIRE_STATUS[openProposal.status] ?? openProposal.status }
          : null,
        activeDraft: activeDraft
          ? {
              id: activeDraft.id,
              createdById: activeDraft.createdById,
              updatedAt: activeDraft.updatedAt.toISOString(),
            }
          : null,
      },
    },
  });
});

async function findTransferableVersion(workspaceId: string, documentId: string, requestedVersion: number) {
  return prisma.documentVersion.findFirst({
    where: {
      documentId,
      workspaceId,
      version: requestedVersion,
      document: {
        archivedAt: null,
      },
    },
    include: {
      document: {
        select: { title: true },
      },
    },
  });
}

async function pipeVersionBlob(
  req: Request,
  res: Response,
  version: NonNullable<Awaited<ReturnType<typeof findTransferableVersion>>>,
  disposition: "attachment" | "inline"
) {
  if (disposition === "inline" && version.mimeType.toLowerCase() === WORD_MIME_TYPE) {
    const sourceBuffer = await streamToBuffer(await getBlob(version.sha256));
    const converted = await mammoth.convertToHtml({ buffer: sourceBuffer });
    const content = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(version.document.title)}</title>
    <style>
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f4f0; color: #1a1a1a; }
      body { margin: 0; padding: 32px 20px; }
      article { max-width: 820px; margin: 0 auto; padding: 56px 64px; background: #fff; box-shadow: 0 1px 4px rgb(0 0 0 / 12%); line-height: 1.6; }
      h1, h2, h3, h4, h5, h6 { line-height: 1.2; margin: 1.5em 0 0.6em; }
      h1:first-child, h2:first-child, h3:first-child { margin-top: 0; }
      p { margin: 0.8em 0; }
      ul, ol { padding-left: 1.5em; }
      table { width: 100%; border-collapse: collapse; margin: 1em 0; }
      th, td { border: 1px solid #d7d7d2; padding: 0.5em 0.65em; text-align: left; vertical-align: top; }
      img { max-width: 100%; height: auto; }
      a { color: #48209e; }
      @media (max-width: 640px) { body { padding: 12px 8px; } article { padding: 28px 22px; } }
    </style>
  </head>
  <body><article>${converted.value}</article></body>
</html>`;
    const contentBuffer = Buffer.from(content, "utf8");
    const previewFilename = safeDownloadFilename(
      version.originalFilename?.replace(/\.docx$/i, ".html") ?? null,
      version.document.title,
      version.version
    );

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Length", contentBuffer.length.toString());
    res.setHeader("Content-Disposition", `${disposition}; filename="${contentDispositionFilename(previewFilename)}"`);
    res.end(contentBuffer);
    return;
  }

  const stream = await getBlob(version.sha256);
  const filename = safeDownloadFilename(
    version.originalFilename,
    version.document.title,
    version.version
  );

  res.setHeader("Content-Type", version.mimeType);
  res.setHeader("Content-Length", version.sizeBytes.toString());
  res.setHeader("Content-Disposition", `${disposition}; filename="${contentDispositionFilename(filename)}"`);

  stream.on("error", (err) => {
    req.log?.error({ err, versionId: version.id }, "Blob stream failed");
    res.destroy(err);
  });

  stream.pipe(res);
}

// --- Preview document version ---

router.get("/:documentId/versions/:version/editor-config", async (req, res) => {
  const documentId = getRouteParam(req, "documentId");
  const requestedVersion = parseVersionParam(getRouteParam(req, "version"));
  const version = await prisma.documentVersion.findFirst({
    where: {
      documentId,
      workspaceId: req.membership!.workspaceId,
      version: requestedVersion,
      document: { archivedAt: null },
    },
    include: { document: { select: { title: true } } },
  });

  if (!version) throw new NotFoundError("Document version not found");
  if (version.mimeType !== WORD_MIME_TYPE) {
    throw new ValidationError("Only DOCX versions can be opened in the native editor");
  }

  res.json({
    ok: true,
    data: {
      editor: buildVersionEditorConfig({
        version,
        user: { id: req.user!.id, name: req.user!.email },
      }),
    },
  });
});

router.get("/:documentId/versions/:version/preview", async (req, res) => {
  const documentId = getRouteParam(req, "documentId");
  const requestedVersion = parseVersionParam(getRouteParam(req, "version"));

  const version = await findTransferableVersion(
    req.membership!.workspaceId,
    documentId,
    requestedVersion
  );

  if (!version) {
    throw new NotFoundError("Document version not found");
  }

  await pipeVersionBlob(req, res, version, "inline");
});

// --- Download document version ---

router.get("/:documentId/versions/:version/download", async (req, res) => {
  const documentId = getRouteParam(req, "documentId");
  const requestedVersion = parseVersionParam(getRouteParam(req, "version"));

  const version = await findTransferableVersion(
    req.membership!.workspaceId,
    documentId,
    requestedVersion
  );

  if (!version) {
    throw new NotFoundError("Document version not found");
  }

  const audit = auditRequestMetadata(req);
  await prisma.auditLog.create({
    data: {
      workspaceId: req.membership!.workspaceId,
      actorId: req.user!.id,
      action: "document_version.downloaded",
      entityType: "document_version",
      entityId: version.id,
      ip: audit.ip,
      userAgent: audit.userAgent,
      metadata: {
        documentId: version.documentId,
        title: version.document.title,
        version: version.version,
        sha256: version.sha256,
        sizeBytes: version.sizeBytes,
        mimeType: version.mimeType,
        originalFilename: version.originalFilename,
      },
    },
  });

  await pipeVersionBlob(req, res, version, "attachment");
});

// --- Markdown -> PDF rendering ---

async function renderMarkdownToPdf(markdown: string): Promise<Buffer> {
  const md = new MarkdownIt({ breaks: true });
  const tokens = md.parse(markdown, {});

  const doc = new PDFDocument({ margin: 72, autoFirstPage: true });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));

  const FONT_NORMAL = "Helvetica";
  const FONT_BOLD = "Helvetica-Bold";
  const FONT_ITALIC = "Helvetica-Oblique";
  const FONT_BOLD_ITALIC = "Helvetica-BoldOblique";
  const FONT_MONO = "Courier";

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];

    if (token.type === "heading_open") {
      const level = parseInt(token.tag.slice(1), 10);
      const inlineToken = tokens[i + 1];
      const text = inlineToken?.children?.map((t) => t.content).join("") ?? "";
      const size = level === 1 ? 22 : level === 2 ? 17 : 14;
      doc.moveDown(0.5).font(FONT_BOLD).fontSize(size).text(text).moveDown(0.3);
      i += 3;
      continue;
    }

    if (token.type === "paragraph_open") {
      const inlineToken = tokens[i + 1];
      if (inlineToken?.type === "inline" && inlineToken.children) {
        doc.font(FONT_NORMAL).fontSize(11);
        const children = inlineToken.children;
        let j = 0;
        let lineText = "";
        const flushLine = (continued: boolean) => {
          if (lineText) {
            doc.text(lineText, { continued });
            lineText = "";
          }
        };
        while (j < children.length) {
          const child = children[j];
          if (child.type === "softbreak" || child.type === "hardbreak") {
            flushLine(false);
            j++;
            continue;
          }
          if (child.type === "strong_open") {
            flushLine(true);
            doc.font(FONT_BOLD);
            j++;
            continue;
          }
          if (child.type === "strong_close") {
            flushLine(true);
            doc.font(FONT_NORMAL);
            j++;
            continue;
          }
          if (child.type === "em_open") {
            flushLine(true);
            const nextIsBoldItalic = j > 0 && children[j - 1]?.type === "strong_open";
            doc.font(nextIsBoldItalic ? FONT_BOLD_ITALIC : FONT_ITALIC);
            j++;
            continue;
          }
          if (child.type === "em_close") {
            flushLine(true);
            doc.font(FONT_NORMAL);
            j++;
            continue;
          }
          if (child.type === "code_inline") {
            flushLine(true);
            doc.font(FONT_MONO).text(child.content, { continued: true });
            doc.font(FONT_NORMAL);
            j++;
            continue;
          }
          if (child.type === "text") {
            lineText += child.content;
          }
          j++;
        }
        flushLine(false);
      }
      doc.moveDown(0.5);
      i += 3;
      continue;
    }

    if (token.type === "bullet_list_open" || token.type === "ordered_list_open") {
      const closeType = token.type === "bullet_list_open" ? "bullet_list_close" : "ordered_list_close";
      let ordinal = 1;
      i++;
      while (i < tokens.length && tokens[i].type !== closeType) {
        const t = tokens[i];
        if (t.type === "list_item_open") {
          i++;
          while (i < tokens.length && tokens[i].type !== "list_item_close") {
            if (tokens[i].type === "inline") {
              const itemText = tokens[i].children?.map((c) => c.content).join("") ?? "";
              const bullet = token.type === "bullet_list_open" ? "•  " : `${ordinal}.  `;
              doc.font(FONT_NORMAL).fontSize(11)
                .text(bullet + itemText, { indent: 12 });
              ordinal++;
            }
            i++;
          }
        }
        i++;
      }
      doc.moveDown(0.3);
      i++;
      continue;
    }

    if (token.type === "fence" || token.type === "code_block") {
      doc.font(FONT_MONO).fontSize(9).text(token.content.trimEnd()).moveDown(0.5);
      doc.font(FONT_NORMAL).fontSize(11);
      i++;
      continue;
    }

    if (token.type === "hr") {
      doc.moveDown(0.3)
        .moveTo(doc.page.margins.left, doc.y)
        .lineTo(doc.page.width - doc.page.margins.right, doc.y)
        .strokeColor("#cccccc").stroke().strokeColor("#000000")
        .moveDown(0.3);
      i++;
      continue;
    }

    i++;
  }

  doc.end();

  await new Promise<void>((resolve) => doc.on("end", resolve));

  return Buffer.concat(chunks);
}

// --- Export version as PDF ---

router.get("/:documentId/versions/:version/export-pdf", async (req, res) => {
  const documentId = getRouteParam(req, "documentId");
  const requestedVersion = parseVersionParam(getRouteParam(req, "version"));

  const version = await prisma.documentVersion.findFirst({
    where: {
      documentId,
      workspaceId: req.membership!.workspaceId,
      version: requestedVersion,
      document: { archivedAt: null },
    },
    include: {
      document: { select: { title: true } },
    },
  });

  if (!version) {
    throw new NotFoundError("Document version not found");
  }

  if (version.mimeType !== "text/markdown") {
    throw new ValidationError("Only Markdown versions can be exported as PDF");
  }

  const markdown = await streamToString(await getBlob(version.sha256));
  const pdfBuffer = await renderMarkdownToPdf(markdown);
  const baseFilename = safeDownloadFilename(
    version.originalFilename?.replace(/\.md$/, ".pdf") ?? null,
    version.document.title,
    version.version
  ).replace(/\.md$/, ".pdf");

  const audit = auditRequestMetadata(req);
  await prisma.auditLog.create({
    data: {
      workspaceId: req.membership!.workspaceId,
      actorId: req.user!.id,
      action: "document_version.exported",
      entityType: "document_version",
      entityId: version.id,
      ip: audit.ip,
      userAgent: audit.userAgent,
      metadata: {
        documentId: version.documentId,
        title: version.document.title,
        version: version.version,
        sha256: version.sha256,
        mimeType: version.mimeType,
      },
    },
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Length", pdfBuffer.length.toString());
  res.setHeader("Content-Disposition", `attachment; filename="${baseFilename}"`);
  res.send(pdfBuffer);
});

export default router;
