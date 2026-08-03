import { Request, Router, RequestHandler } from "express";
import multer from "multer";
import { Readable } from "stream";
import { createHash } from "crypto";
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
  createdAt: Date;
}) {
  return {
    id: version.id,
    version: version.version,
    sha256: version.sha256,
    sizeBytes: version.sizeBytes,
    mimeType: version.mimeType,
    createdAt: version.createdAt.toISOString(),
  };
}

function safeDownloadFilename(title: string, version: number) {
  const safeTitle = title
    .trim()
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 120);

  return `${safeTitle || "document"}-v${version}`;
}

function parseVersionParam(value: string) {
  const version = Number(value);

  if (!Number.isInteger(version) || version < 1) {
    throw new ValidationError("Version must be a positive integer");
  }

  return version;
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
  const documents = await prisma.document.findMany({
    where: {
      workspaceId: req.membership!.workspaceId,
    },
    include: {
      versions: {
        orderBy: { version: "desc" },
        take: 1,
      },
    },
    orderBy: { createdAt: "desc" },
  });

  res.json({
    ok: true,
    data: {
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

  if (!query) {
    throw new ValidationError("Search query is required");
  }

  const matches = await prisma.documentSearch.findMany({
    where: {
      workspaceId: req.membership!.workspaceId,
      status: "indexed",
      plainText: {
        contains: query,
        mode: "insensitive",
      },
    },
    include: {
      version: {
        include: {
          document: true,
        },
      },
    },
    orderBy: { indexedAt: "desc" },
    take: 25,
  });

  res.json({
    ok: true,
    data: {
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
        },
      })),
    },
  });
});

// --- Get document detail ---

router.get("/:documentId", async (req, res) => {
  const documentId = getRouteParam(req, "documentId");

  const document = await prisma.document.findFirst({
    where: {
      id: documentId,
      workspaceId: req.membership!.workspaceId,
    },
    include: {
      versions: {
        orderBy: { version: "asc" },
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
      },
    },
  });

  const stream = await getBlob(version.sha256);
  const filename = safeDownloadFilename(version.document.title, version.version);

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
