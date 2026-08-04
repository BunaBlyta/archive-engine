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
