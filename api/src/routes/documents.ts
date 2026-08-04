import { Request, Router, RequestHandler } from "express";
import multer from "multer";
import { Readable } from "stream";
import { createHash } from "crypto";
import { z } from "zod";
import { prisma } from "@archive/db";
import { blobExists, getBlob, putBlob } from "@archive/storage";
import { NotFoundError, ValidationError } from "../middleware/errorHandler";

const router = Router({ mergeParams: true });

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
  const sha256 = createHash("sha256").update(file.buffer).digest("hex");
  const sizeBytes = file.size;
  const mimeType = file.mimetype || "application/octet-stream";

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
    search: version.search
      ? {
          status: version.search.status,
          indexedAt: version.search.indexedAt.toISOString(),
          error: version.search.error,
        }
      : null,
  };
}

function safeDownloadFilename(filename: string | null, title: string, version: number) {
  const name = filename ?? `${title}-v${version}`;
  const safeName = name
    .trim()
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 120);

  return safeName || `document-v${version}`;
}

function parseVersionParam(value: string) {
  const version = Number(value);

  if (!Number.isInteger(version) || version < 1) {
    throw new ValidationError("Version must be a positive integer");
  }

  return version;
}

function createSearchSnippet(plainText: string | null, query: string) {
  if (!plainText) return null;

  const normalizedText = plainText.replace(/\s+/g, " ").trim();
  const index = normalizedText.toLowerCase().indexOf(query.toLowerCase());

  if (index === -1) return null;

  const contextChars = 80;
  const start = Math.max(0, index - contextChars);
  const end = Math.min(normalizedText.length, index + query.length + contextChars);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < normalizedText.length ? "..." : "";

  return `${prefix}${normalizedText.slice(start, end)}${suffix}`;
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

function isTextLikeMimeType(mimeType: string) {
  const normalized = mimeType.toLowerCase();

  return (
    normalized.startsWith("text/") ||
    normalized === "application/json" ||
    normalized === "application/xml" ||
    normalized === "application/javascript" ||
    normalized.endsWith("+json") ||
    normalized.endsWith("+xml")
  );
}

async function readTextVersion(version: { sha256: string; mimeType: string }) {
  if (!isTextLikeMimeType(version.mimeType)) {
    throw new ValidationError("Latest document version is not plain text");
  }

  return streamToString(await getBlob(version.sha256));
}

function formatDraft(draft: {
  id: string;
  workspaceId: string;
  documentId: string;
  baseVersionId: string;
  title: string;
  content: string;
  status: string;
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
    status: draft.status,
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
  status: string;
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
    status: draft.status,
    createdById: draft.createdById,
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString(),
  };
}

function formatProposedChange(proposedChange: {
  id: string;
  workspaceId: string;
  documentId: string;
  draftId: string;
  status: string;
  summary: string | null;
  openedById: string | null;
  openedAt: Date;
  closedAt: Date | null;
}) {
  return {
    id: proposedChange.id,
    workspaceId: proposedChange.workspaceId,
    documentId: proposedChange.documentId,
    draftId: proposedChange.draftId,
    status: proposedChange.status,
    summary: proposedChange.summary,
    openedById: proposedChange.openedById,
    openedAt: proposedChange.openedAt.toISOString(),
    closedAt: proposedChange.closedAt?.toISOString() ?? null,
  };
}

function formatReview(review: {
  id: string;
  workspaceId: string;
  proposedChangeId: string;
  reviewerId: string | null;
  state: string;
  body: string | null;
  createdAt: Date;
}) {
  return {
    id: review.id,
    workspaceId: review.workspaceId,
    proposedChangeId: review.proposedChangeId,
    reviewerId: review.reviewerId,
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

function createLineDiff(baseContent: string, draftContent: string) {
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

  const lines: Array<{
    type: "unchanged" | "added" | "removed";
    oldLineNumber: number | null;
    newLineNumber: number | null;
    text: string;
  }> = [];
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

function textFilenameFromTitle(title: string, version: number) {
  const baseName = title
    .trim()
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 100)
    .replace(/^-|-$/g, "")
    .toLowerCase();

  return `${baseName || "document"}-v${version}.txt`;
}

function auditRequestMetadata(req: Request) {
  return {
    ip: req.ip,
    userAgent: req.get("user-agent"),
  };
}

type SearchJobTransaction = {
  documentSearch: typeof prisma.documentSearch;
  job: typeof prisma.job;
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
      documents: documents.map((document) => ({
        id: document.id,
        workspaceId: document.workspaceId,
        title: document.title,
        createdAt: document.createdAt.toISOString(),
        latestVersion: document.versions[0]
          ? formatVersion(document.versions[0])
          : null,
      })),
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

  const matches = await prisma.documentSearch.findMany({
    where: {
      workspaceId: req.membership!.workspaceId,
      status: "indexed",
      version: {
        document: {
          archivedAt: null,
        },
      },
      plainText: {
        contains: query,
        mode: "insensitive",
      },
    },
    include: {
      version: {
        include: {
          document: true,
          search: {
            select: {
              status: true,
              indexedAt: true,
              error: true,
            },
          },
        },
      },
    },
    orderBy: { indexedAt: "desc" },
    take: limit,
    skip: offset,
  });

  res.json({
    ok: true,
    data: {
      pagination: {
        limit,
        offset,
        nextOffset: matches.length === limit ? offset + limit : null,
      },
      results: matches.map((match) => ({
        document: {
          id: match.version.document.id,
          workspaceId: match.version.document.workspaceId,
          title: match.version.document.title,
          createdAt: match.version.document.createdAt.toISOString(),
        },
        version: formatVersion(match.version),
        search: {
          status: match.status,
          indexedAt: match.indexedAt.toISOString(),
          snippet: createSearchSnippet(match.plainText, query),
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

  const content = await readTextVersion(latestVersion);
  const audit = auditRequestMetadata(req);

  const draft = await prisma.$transaction(async (tx) => {
    const created = await tx.documentDraft.create({
      data: {
        workspaceId: req.membership!.workspaceId,
        documentId: document.id,
        baseVersionId: latestVersion.id,
        title: document.title,
        content,
        status: "draft",
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

  if (existing.status !== "draft") {
    throw new ValidationError("Only draft changes can be updated");
  }

  const draft = await prisma.documentDraft.update({
    where: { id: existing.id },
    data: {
      content: parsed.data.content,
    },
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
  });

  if (!existing) {
    throw new NotFoundError("Draft not found");
  }

  if (existing.status !== "draft") {
    throw new ValidationError("Only draft changes can be proposed");
  }

  const audit = auditRequestMetadata(req);
  const proposedChange = await prisma.$transaction(async (tx) => {
    await tx.documentDraft.update({
      where: { id: existing.id },
      data: { status: "proposed" },
    });

    const opened = await tx.proposedChange.create({
      data: {
        workspaceId: req.membership!.workspaceId,
        documentId,
        draftId: existing.id,
        status: "open",
        summary: parsed.data.summary ?? null,
        openedById: req.user!.id,
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
          draftId: existing.id,
          baseVersionId: existing.baseVersionId,
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

// --- Get proposed change detail ---

router.get("/:documentId/proposed-changes/:proposedChangeId", async (req, res) => {
  const documentId = getRouteParam(req, "documentId");
  const proposedChangeId = getRouteParam(req, "proposedChangeId");

  const proposedChange = await prisma.proposedChange.findFirst({
    where: {
      id: proposedChangeId,
      documentId,
      workspaceId: req.membership!.workspaceId,
      document: {
        archivedAt: null,
      },
    },
    include: {
      draft: {
        include: {
          baseVersion: {
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
        },
      },
      reviews: {
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!proposedChange) {
    throw new NotFoundError("Proposed change not found");
  }

  const baseContent = await readTextVersion(proposedChange.draft.baseVersion);
  const draftContent = proposedChange.draft.content;

  res.json({
    ok: true,
    data: {
      proposedChange: formatProposedChange(proposedChange),
      draft: formatDraftMetadata(proposedChange.draft),
      baseVersion: formatVersion(proposedChange.draft.baseVersion),
      baseContent,
      draftContent,
      diff: createLineDiff(baseContent, draftContent),
      reviews: proposedChange.reviews.map(formatReview),
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

  const existing = await prisma.proposedChange.findFirst({
    where: {
      id: proposedChangeId,
      documentId,
      workspaceId: req.membership!.workspaceId,
      document: {
        archivedAt: null,
      },
    },
  });

  if (!existing) {
    throw new NotFoundError("Proposed change not found");
  }

  if (existing.status === "published" || existing.status === "closed") {
    throw new ValidationError("Closed proposed changes cannot be reviewed");
  }

  const audit = auditRequestMetadata(req);
  const result = await prisma.$transaction(async (tx) => {
    const review = await tx.review.create({
      data: {
        workspaceId: req.membership!.workspaceId,
        proposedChangeId: existing.id,
        reviewerId: req.user!.id,
        state: parsed.data.state,
        body: parsed.data.body ?? null,
      },
    });

    const nextStatus =
      parsed.data.state === "approved"
        ? "approved"
        : parsed.data.state === "changes_requested"
          ? "changes_requested"
          : existing.status;

    const proposedChange =
      nextStatus === existing.status
        ? existing
        : await tx.proposedChange.update({
            where: { id: existing.id },
            data: { status: nextStatus },
          });

    await tx.auditLog.create({
      data: {
        workspaceId: req.membership!.workspaceId,
        actorId: req.user!.id,
        action: "proposed_change.reviewed",
        entityType: "proposed_change",
        entityId: existing.id,
        ip: audit.ip,
        userAgent: audit.userAgent,
        metadata: {
          documentId,
          reviewId: review.id,
          state: review.state,
          status: proposedChange.status,
        },
      },
    });

    return { review, proposedChange };
  });

  res.status(201).json({
    ok: true,
    data: {
      review: formatReview(result.review),
      proposedChangeStatus: result.proposedChange.status,
    },
  });
});

// --- Publish proposed change ---

router.post("/:documentId/proposed-changes/:proposedChangeId/publish", async (req, res) => {
  const documentId = getRouteParam(req, "documentId");
  const proposedChangeId = getRouteParam(req, "proposedChangeId");

  const existing = await prisma.proposedChange.findFirst({
    where: {
      id: proposedChangeId,
      documentId,
      workspaceId: req.membership!.workspaceId,
      document: {
        archivedAt: null,
      },
    },
    include: {
      draft: true,
      document: {
        select: {
          id: true,
          workspaceId: true,
          title: true,
        },
      },
    },
  });

  if (!existing) {
    throw new NotFoundError("Proposed change not found");
  }

  if (existing.status !== "approved") {
    throw new ValidationError("Proposed change must be approved before publishing");
  }

  const contentBuffer = Buffer.from(existing.draft.content, "utf8");
  const sha256 = createHash("sha256").update(contentBuffer).digest("hex");
  const sizeBytes = contentBuffer.length;
  const mimeType = "text/plain";

  if (!(await blobExists(sha256))) {
    await putBlob(sha256, Readable.from(contentBuffer), sizeBytes, mimeType);
  }

  const audit = auditRequestMetadata(req);
  const version = await prisma.$transaction(async (tx) => {
    const proposedChange = await tx.proposedChange.findFirst({
      where: {
        id: existing.id,
        workspaceId: req.membership!.workspaceId,
        documentId,
        status: "approved",
        document: {
          archivedAt: null,
        },
      },
      include: {
        draft: true,
        document: {
          select: {
            id: true,
            workspaceId: true,
            title: true,
          },
        },
      },
    });

    if (!proposedChange) {
      throw new ValidationError("Proposed change must be approved before publishing");
    }

    const latestVersion = await tx.documentVersion.aggregate({
      where: {
        documentId: proposedChange.documentId,
        workspaceId: req.membership!.workspaceId,
      },
      _max: { version: true },
    });
    const nextVersion = (latestVersion._max.version ?? 0) + 1;

    const blob = await tx.blob.upsert({
      where: { sha256 },
      update: {},
      create: {
        sha256,
        sizeBytes,
        storageKey: sha256,
      },
    });

    const publishedVersion = await tx.documentVersion.create({
      data: {
        workspaceId: req.membership!.workspaceId,
        documentId: proposedChange.documentId,
        version: nextVersion,
        blobId: blob.id,
        sha256,
        sizeBytes,
        mimeType,
        originalFilename: textFilenameFromTitle(proposedChange.document.title, nextVersion),
        createdById: req.user!.id,
      },
    });

    await createSearchIndexJob(tx, publishedVersion);

    const closedAt = new Date();
    await tx.proposedChange.update({
      where: { id: proposedChange.id },
      data: {
        status: "published",
        closedAt,
      },
    });

    await tx.documentDraft.update({
      where: { id: proposedChange.draftId },
      data: { status: "published" },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: req.membership!.workspaceId,
        actorId: req.user!.id,
        action: "proposed_change.published",
        entityType: "proposed_change",
        entityId: proposedChange.id,
        ip: audit.ip,
        userAgent: audit.userAgent,
        metadata: {
          documentId: proposedChange.documentId,
          draftId: proposedChange.draftId,
          versionId: publishedVersion.id,
          version: publishedVersion.version,
          sha256,
          sizeBytes,
          mimeType,
          originalFilename: publishedVersion.originalFilename,
          closedAt: closedAt.toISOString(),
        },
      },
    });

    return publishedVersion;
  });

  res.status(201).json({
    ok: true,
    data: {
      version: formatVersion(version),
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
          search: {
            select: {
              status: true,
              indexedAt: true,
              error: true,
            },
          },
        },
      },
    },
  });

  if (!document) {
    throw new NotFoundError("Document not found");
  }

  res.json({
    ok: true,
    data: {
      document: {
        id: document.id,
        workspaceId: document.workspaceId,
        title: document.title,
        createdAt: document.createdAt.toISOString(),
        versions: document.versions.map(formatVersion),
      },
    },
  });
});

// --- Create document version ---

router.post("/:documentId/versions", uploadSingleFile, async (req, res) => {
  const documentId = getRouteParam(req, "documentId");
  const file = requireUploadedFile(req);
  const { sha256, sizeBytes, mimeType } = await ingestUploadedFile(file);

  const result = await prisma.$transaction(async (tx) => {
    const audit = auditRequestMetadata(req);
    const document = await tx.document.findFirst({
      where: {
        id: documentId,
        workspaceId: req.membership!.workspaceId,
        archivedAt: null,
      },
      select: { id: true, workspaceId: true, title: true, createdAt: true },
    });

    if (!document) {
      throw new NotFoundError("Document not found");
    }

    const latestVersion = await tx.documentVersion.aggregate({
      where: {
        documentId: document.id,
        workspaceId: req.membership!.workspaceId,
      },
      _max: { version: true },
    });

    const nextVersion = (latestVersion._max.version ?? 0) + 1;

    const blob = await tx.blob.upsert({
      where: { sha256 },
      update: {},
      create: {
        sha256,
        sizeBytes,
        storageKey: sha256,
      },
    });

    const version = await tx.documentVersion.create({
      data: {
        workspaceId: req.membership!.workspaceId,
        documentId: document.id,
        version: nextVersion,
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
        action: "document_version.created",
        entityType: "document_version",
        entityId: version.id,
        ip: audit.ip,
        userAgent: audit.userAgent,
        metadata: {
          documentId: document.id,
          title: document.title,
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

// --- Download document version ---

router.get("/:documentId/versions/:version/download", async (req, res) => {
  const documentId = getRouteParam(req, "documentId");
  const requestedVersion = parseVersionParam(getRouteParam(req, "version"));

  const version = await prisma.documentVersion.findFirst({
    where: {
      documentId,
      workspaceId: req.membership!.workspaceId,
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

  const stream = await getBlob(version.sha256);
  const filename = safeDownloadFilename(
    version.originalFilename,
    version.document.title,
    version.version
  );

  res.setHeader("Content-Type", version.mimeType);
  res.setHeader("Content-Length", version.sizeBytes.toString());
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  stream.on("error", (err) => {
    req.log?.error({ err, versionId: version.id }, "Blob download stream failed");
    res.destroy(err);
  });

  stream.pipe(res);
});

export default router;
