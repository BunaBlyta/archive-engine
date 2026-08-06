import { Router } from "express";
import { createHash } from "crypto";
import { Readable } from "stream";
import jwt from "jsonwebtoken";
import { prisma } from "@archive/db";
import { blobExists, getBlob, putBlob } from "@archive/storage";
import { UnauthorizedError, ValidationError } from "../middleware/errorHandler";

const router = Router();

const WORD_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
// Must track isDraftInWritableState in documents.ts. "proposed" was the pre-merge value and
// no longer exists: a draft sent back for revision is now "changes_requested".
const EDITABLE_DRAFT_STATUSES = ["draft", "changes_requested"];
const EDITOR_SECRET = () => process.env.ONLYOFFICE_JWT_SECRET!;
const DOCUMENT_SERVER_URL = () => process.env.ONLYOFFICE_URL ?? "http://localhost:8080";
const EDITOR_PUBLIC_API_URL = () => process.env.EDITOR_PUBLIC_API_URL ?? "http://host.docker.internal:3000";

type EditorFileClaims = {
  purpose: "onlyoffice-file";
  draftId?: string;
  versionId?: string;
};

type OnlyOfficeCallback = {
  key?: string;
  status?: number;
  url?: string;
  users?: string[];
};

export type OnlyOfficeEditorConfig = {
  documentServerUrl: string;
  document: {
    fileType: "docx";
    key: string;
    title: string;
    url: string;
    permissions: { edit: boolean; download: boolean; review: boolean };
  };
  documentType: "word";
  editorConfig: {
    mode: "edit" | "view";
    callbackUrl?: string;
    user?: { id: string; name: string };
    customization: { compactHeader: boolean };
  };
  token: string;
};

function editorKey(seed: string) {
  return createHash("sha256").update(seed).digest("hex").slice(0, 40);
}

export function createOnlyOfficeToken(payload: object) {
  return jwt.sign(payload, EDITOR_SECRET(), { algorithm: "HS256", expiresIn: "1h" });
}

export function createEditorFileToken(payload: Omit<EditorFileClaims, "purpose">) {
  return jwt.sign({ ...payload, purpose: "onlyoffice-file" }, EDITOR_SECRET(), { algorithm: "HS256", expiresIn: "10m" });
}

function verifyEditorFileToken(value: string): EditorFileClaims {
  try {
    const payload = jwt.verify(value, EDITOR_SECRET(), { algorithms: ["HS256"] }) as EditorFileClaims;
    if (payload.purpose !== "onlyoffice-file" || (!payload.draftId && !payload.versionId)) {
      throw new Error("Invalid editor file token");
    }
    return payload;
  } catch {
    throw new UnauthorizedError("Invalid or expired document editor link");
  }
}

function bearerToken(value: string | undefined) {
  if (!value) return undefined;
  return value.startsWith("Bearer ") ? value.slice("Bearer ".length) : value;
}

function safeFilename(value: string | null | undefined, fallback: string) {
  return (value ?? fallback).replace(/[\\/\?%\*:|"<>]/g, "-").replace(/[\r\n]/g, "-");
}

export function buildDraftEditorConfig(input: {
  draft: {
    id: string;
    editorKey: string | null;
    title: string;
    artifactOriginalFilename: string | null;
  };
  user: { id: string; name: string };
  editable: boolean;
}) {
  if (!input.draft.editorKey) {
    throw new ValidationError("DOCX draft editor is not initialized");
  }

  const fileToken = createEditorFileToken({ draftId: input.draft.id });
  const config = {
    document: {
      fileType: "docx" as const,
      key: input.draft.editorKey,
      title: safeFilename(input.draft.artifactOriginalFilename, `${input.draft.title}.docx`),
      url: `${EDITOR_PUBLIC_API_URL()}/v1/editor/files/${input.draft.id}?token=${encodeURIComponent(fileToken)}`,
      permissions: { edit: input.editable, download: true, review: true },
    },
    documentType: "word" as const,
    editorConfig: {
      mode: input.editable ? "edit" as const : "view" as const,
      callbackUrl: `${EDITOR_PUBLIC_API_URL()}/v1/editor/callbacks/${input.draft.id}`,
      user: input.user,
      customization: { compactHeader: true },
    },
  };

  return {
    documentServerUrl: DOCUMENT_SERVER_URL(),
    ...config,
    token: createOnlyOfficeToken({
      ...config,
      purpose: "onlyoffice-callback",
      draftId: input.draft.id,
      editorKey: input.draft.editorKey,
    }),
  } satisfies OnlyOfficeEditorConfig;
}

export function buildVersionEditorConfig(input: {
  version: {
    id: string;
    version: number;
    originalFilename: string | null;
    document: { title: string };
  };
  user: { id: string; name: string };
}) {
  const fileToken = createEditorFileToken({ versionId: input.version.id });
  const config = {
    document: {
      fileType: "docx" as const,
      key: `version-${input.version.id}`,
      title: safeFilename(input.version.originalFilename, `${input.version.document.title}-v${input.version.version}.docx`),
      url: `${EDITOR_PUBLIC_API_URL()}/v1/editor/files/${input.version.id}?token=${encodeURIComponent(fileToken)}`,
      permissions: { edit: false, download: true, review: true },
    },
    documentType: "word" as const,
    editorConfig: {
      mode: "view" as const,
      user: input.user,
      customization: { compactHeader: true },
    },
  };

  return {
    documentServerUrl: DOCUMENT_SERVER_URL(),
    ...config,
    token: createOnlyOfficeToken(config),
  } satisfies OnlyOfficeEditorConfig;
}

export async function forceSaveDraftEditor(draft: { editorKey: string | null }) {
  if (!draft.editorKey) {
    throw new ValidationError("DOCX draft editor is not initialized");
  }

  const command = { c: "forcesave", key: draft.editorKey };
  const response = await fetch(`${DOCUMENT_SERVER_URL()}/coauthoring/CommandService.ashx`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...command, token: createOnlyOfficeToken(command) }),
  });

  if (!response.ok) {
    throw new ValidationError(`ONLYOFFICE force-save failed with status ${response.status}`);
  }

  const body = (await response.json()) as { error?: number };
  if (body.error && body.error !== 0) {
    throw new ValidationError(`ONLYOFFICE force-save failed with code ${body.error}`);
  }
}

async function downloadEditedDocument(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new ValidationError(`ONLYOFFICE could not provide the edited document (${response.status})`);
  }
  return Buffer.from(await response.arrayBuffer());
}

router.get("/files/:id", async (req, res) => {
  const tokenValue = typeof req.query.token === "string" ? req.query.token : "";
  const claims = verifyEditorFileToken(tokenValue);

  if (claims.draftId && claims.draftId !== req.params.id) {
    throw new UnauthorizedError("Document editor link does not match the requested draft");
  }
  if (claims.versionId && claims.versionId !== req.params.id) {
    throw new UnauthorizedError("Document editor link does not match the requested version");
  }

  let sha256: string | null = null;
  let sizeBytes: number | null = null;
  let filename: string | null = null;

  if (claims.draftId) {
    const draft = await prisma.documentDraft.findUnique({
      where: { id: claims.draftId },
      select: {
        artifactSha256: true,
        artifactSizeBytes: true,
        artifactMimeType: true,
        artifactOriginalFilename: true,
        baseVersion: { select: { sha256: true, sizeBytes: true, mimeType: true, originalFilename: true } },
      },
    });
    if (!draft) throw new UnauthorizedError("Draft editor link is no longer valid");
    sha256 = draft.artifactSha256 ?? draft.baseVersion.sha256;
    sizeBytes = draft.artifactSizeBytes ?? draft.baseVersion.sizeBytes;
    filename = draft.artifactOriginalFilename ?? draft.baseVersion.originalFilename;
    if ((draft.artifactMimeType ?? draft.baseVersion.mimeType) !== WORD_MIME_TYPE) {
      throw new ValidationError("The selected draft is not a DOCX document");
    }
  } else if (claims.versionId) {
    const version = await prisma.documentVersion.findUnique({
      where: { id: claims.versionId },
      select: { sha256: true, sizeBytes: true, mimeType: true, originalFilename: true },
    });
    if (!version) throw new UnauthorizedError("Version editor link is no longer valid");
    if (version.mimeType !== WORD_MIME_TYPE) throw new ValidationError("The selected version is not a DOCX document");
    sha256 = version.sha256;
    sizeBytes = version.sizeBytes;
    filename = version.originalFilename;
  }

  if (!sha256 || sizeBytes === null) throw new UnauthorizedError("Document editor link is no longer valid");

  const stream = await getBlob(sha256);
  res.setHeader("Content-Type", WORD_MIME_TYPE);
  res.setHeader("Content-Length", sizeBytes.toString());
  res.setHeader("Content-Disposition", `inline; filename="${safeFilename(filename, "document.docx")}"`);
  stream.pipe(res);
});

router.post("/callbacks/:draftId", async (req, res) => {
  const token = bearerToken(req.get("authorization")) ?? (typeof req.body?.token === "string" ? req.body.token : undefined);
  if (!token) throw new UnauthorizedError("ONLYOFFICE callback token is required");

  const draft = await prisma.documentDraft.findUnique({
    where: { id: req.params.draftId },
    select: {
      id: true,
      documentId: true,
      workspaceId: true,
      editorKey: true,
      createdById: true,
      baseVersionId: true,
      title: true,
      status: true,
    },
  });
  if (!draft) throw new ValidationError("DOCX draft was not found");

  // Document Server does not echo back the token issued in the editor config — it signs its
  // OWN callback body with the shared secret. So the verified payload IS the callback, and it
  // carries none of our claims. Trust the signed payload over req.body, which is unauthenticated.
  // When the token arrives in the Authorization header some versions nest it under `payload`.
  let callback: OnlyOfficeCallback;
  try {
    const decoded = jwt.verify(token, EDITOR_SECRET(), { algorithms: ["HS256"] }) as Record<string, unknown>;
    const nested = decoded.payload;
    callback = (nested && typeof nested === "object" ? nested : decoded) as OnlyOfficeCallback;
  } catch {
    throw new UnauthorizedError("Invalid ONLYOFFICE callback token");
  }

  // The editor key is what binds a signed callback to this draft's editing session: it is
  // unguessable, regenerated on every save, and unique per draft.
  if (!draft.editorKey || callback.key !== draft.editorKey) {
    throw new UnauthorizedError("ONLYOFFICE callback does not match the draft editor session");
  }

  if (callback.status === 1 || callback.status === 4) {
    res.json({ error: 0 });
    return;
  }

  // A draft that has been published or is awaiting review is frozen. Answer with a plain
  // error code rather than throwing so ONLYOFFICE stops instead of retrying the save.
  if (!EDITABLE_DRAFT_STATUSES.includes(draft.status)) {
    res.json({ error: 1 });
    return;
  }

  if (callback.status !== 2 && callback.status !== 6) {
    res.json({ error: 1 });
    return;
  }

  if (!callback.url) throw new ValidationError("ONLYOFFICE callback did not include an edited document URL");

  const contentBuffer = await downloadEditedDocument(callback.url);
  const sha256 = createHash("sha256").update(contentBuffer).digest("hex");
  if (!(await blobExists(sha256))) {
    await putBlob(sha256, Readable.from(contentBuffer), contentBuffer.length, WORD_MIME_TYPE);
  }

  // Keep Markdown text alongside the DOCX so the existing search and redline UI remains useful.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mammoth = require("mammoth") as { convertToMarkdown: (input: { buffer: Buffer }) => Promise<{ value: string }> };
  const converted = await mammoth.convertToMarkdown({ buffer: contentBuffer });
  const nextEditorKey = callback.status === 2 ? editorKey(`${draft.id}:${sha256}:${Date.now()}`) : draft.editorKey;

  // ONLYOFFICE reports the editing user in `users`. The value comes back over the wire, so it
  // is only trusted as an actor once it resolves to a member of the draft's workspace.
  const reportedUserId = callback.users?.find((value) => typeof value === "string" && value.length > 0);
  const editorUserId = reportedUserId
    ? (
        await prisma.membership.findUnique({
          where: { workspaceId_userId: { workspaceId: draft.workspaceId, userId: reportedUserId } },
          select: { userId: true },
        })
      )?.userId ?? null
    : null;
  const actorId = editorUserId ?? draft.createdById;

  const saved = await prisma.$transaction(async (tx) => {
    // Re-check status in the write itself: a publish committing between the guard above and
    // this transaction must not have its content overwritten.
    const written = await tx.documentDraft.updateMany({
      where: { id: draft.id, status: { in: EDITABLE_DRAFT_STATUSES } },
      data: {
        content: converted.value,
        contentFormat: "markdown",
        editorKey: nextEditorKey,
        artifactSha256: sha256,
        artifactSizeBytes: contentBuffer.length,
        artifactMimeType: WORD_MIME_TYPE,
        artifactOriginalFilename: `${draft.title}.docx`,
      },
    });

    if (written.count === 0) {
      return false;
    }

    await tx.auditLog.create({
      data: {
        workspaceId: draft.workspaceId,
        actorId,
        action: "document_draft.docx_saved",
        entityType: "document_draft",
        entityId: draft.id,
        metadata: {
          documentId: draft.documentId,
          draftId: draft.id,
          status: callback.status,
          sha256,
          editorUserId,
          reportedUserId: reportedUserId ?? null,
          draftCreatedById: draft.createdById,
        },
      },
    });

    return true;
  });

  res.json({ error: saved ? 0 : 1 });
});

export default router;
