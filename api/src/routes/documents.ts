import { Router, RequestHandler } from "express";
import multer from "multer";
import { Readable } from "stream";
import { createHash } from "crypto";
import { prisma } from "@archive/db";
import { blobExists, putBlob } from "@archive/storage";
import { ValidationError } from "../middleware/errorHandler";

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

router.post("/", uploadSingleFile, async (req, res) => {
  const title = getStringField(req.body.title)?.trim();

  if (!title) {
    throw new ValidationError("Document title is required");
  }

  if (!req.file) {
    throw new ValidationError("Document file is required");
  }

  const sha256 = createHash("sha256").update(req.file.buffer).digest("hex");
  const sizeBytes = req.file.size;
  const mimeType = req.file.mimetype || "application/octet-stream";

  if (!(await blobExists(sha256))) {
    await putBlob(sha256, Readable.from(req.file.buffer), sizeBytes, mimeType);
  }

  const result = await prisma.$transaction(async (tx) => {
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
      version: {
        id: result.version.id,
        version: result.version.version,
        sha256: result.version.sha256,
        sizeBytes: result.version.sizeBytes,
        mimeType: result.version.mimeType,
        createdAt: result.version.createdAt.toISOString(),
      },
    },
  });
});

export default router;
