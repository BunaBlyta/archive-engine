import dotenv from "dotenv";

dotenv.config({ path: `${__dirname}/../../.env` });

import { prisma } from "@archive/db";
import { getBlob } from "@archive/storage";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mammoth = require("mammoth") as {
  convertToMarkdown: (input: { buffer: Buffer }) => Promise<{ value: string }>;
};
import { PDFParse } from "pdf-parse";
import { Readable } from "stream";

const WORKER_ID = `worker-${process.pid}`;

const LOCK_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

let running = true;

type IndexDocumentVersionPayload = {
  versionId: string;
  workspaceId: string;
  documentId: string;
};

process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down worker...");
  running = false;
});

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down worker...");
  running = false;
});

async function claimNextJob() {
  const now = new Date();
  const staleBefore = new Date(Date.now() - LOCK_TIMEOUT_MS);

  // Find a job that is either:
  // - queued and due, OR
  // - running but lock is stale
  const candidate = await prisma.job.findFirst({
    where: {
      runAt: { lte: now },
      OR: [
        { status: "queued" },
        { status: "running", lockedAt: { lt: staleBefore } },
      ],
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, type: true, payload: true, attempts: true, maxAttempts: true },
  });

  if (!candidate) return null;

  // Try to claim it atomically: only succeeds if it's still claimable
  const result = await prisma.job.updateMany({
    where: {
      id: candidate.id,
      runAt: { lte: now },
      OR: [
        { status: "queued" },
        { status: "running", lockedAt: { lt: staleBefore } },
      ],
    },
    data: {
      status: "running",
      lockedAt: now,
      lockedBy: WORKER_ID,
      attempts: { increment: 1 },
    },
  });

  if (result.count === 0) return null; // someone else claimed it first

  return {
    id: candidate.id,
    type: candidate.type,
    payload: candidate.payload,
    attempts: candidate.attempts + 1, // reflect the increment applied above
    maxAttempts: candidate.maxAttempts,
  };
}

async function runJob(job: {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}) {
  if (job.type === "PING") {
    // pretend work
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "succeeded", lockedAt: null, lockedBy: null },
    });
    return;
  }

  if (job.type === "INDEX_DOCUMENT_VERSION") {
    await indexDocumentVersion(job.payload);
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "succeeded", lockedAt: null, lockedBy: null },
    });
    return;
  }

  throw new Error(`Unknown job type: ${job.type}`);
}

function parseIndexDocumentVersionPayload(payload: unknown): IndexDocumentVersionPayload {
  if (typeof payload === "object" && payload !== null) {
    const value = payload as Record<string, unknown>;

    if (
      typeof value.versionId === "string" &&
      typeof value.workspaceId === "string" &&
      typeof value.documentId === "string"
    ) {
      return {
        versionId: value.versionId,
        workspaceId: value.workspaceId,
        documentId: value.documentId,
      };
    }
  }

  throw new Error("Invalid INDEX_DOCUMENT_VERSION payload");
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

function isTextMimeType(mimeType: string) {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType.endsWith("+json")
  );
}

function isPdfMimeType(mimeType: string) {
  return mimeType === "application/pdf";
}

function isWordMimeType(mimeType: string) {
  return mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });

  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

// Heuristic structure detection on extracted PDF text.
// Returns markdown text if structure is detected, or null for plain.
function detectAndConvertPdfStructure(text: string): string | null {
  const lines = text.split("\n");
  let headingCount = 0;
  let bulletCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (/^[•\-*]\s+\S/.test(line) || /^\d+\.\s+\S/.test(line)) {
      bulletCount++;
      continue;
    }

    // Heading: short, no ending sentence punctuation, surrounded by blank lines
    const prevBlank = i === 0 || !lines[i - 1].trim();
    const nextBlank = i === lines.length - 1 || !lines[i + 1].trim();
    if (line.length < 80 && !/[.,:;]$/.test(line) && prevBlank && nextBlank) {
      headingCount++;
    }
  }

  if (headingCount < 2 && bulletCount < 3) {
    return null; // no meaningful structure — stay plain
  }

  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line) {
      out.push("");
      continue;
    }

    // Normalize bullet markers to markdown
    if (/^•\s+/.test(line)) {
      out.push(line.replace(/^•\s+/, "- "));
      continue;
    }
    if (/^[*\-]\s+\S/.test(line) || /^\d+\.\s+\S/.test(line)) {
      out.push(line);
      continue;
    }

    // Heading
    const prevBlank = i === 0 || !lines[i - 1].trim();
    const nextBlank = i === lines.length - 1 || !lines[i + 1].trim();
    if (line.length < 80 && !/[.,:;]$/.test(line) && prevBlank && nextBlank) {
      out.push(`## ${line}`);
      continue;
    }

    out.push(line);
  }

  return out.join("\n");
}

type ExtractionResult = { plainText: string; format: "plain" | "markdown" };

async function extractContent(version: { sha256: string; mimeType: string }): Promise<ExtractionResult | null> {
  const stream = await getBlob(version.sha256);

  if (isTextMimeType(version.mimeType)) {
    return { plainText: await streamToString(stream), format: "plain" };
  }

  if (isWordMimeType(version.mimeType)) {
    const buffer = await streamToBuffer(stream);
    const result = await mammoth.convertToMarkdown({ buffer });
    return { plainText: result.value, format: "markdown" };
  }

  if (isPdfMimeType(version.mimeType)) {
    const buffer = await streamToBuffer(stream);
    const rawText = await extractPdfText(buffer);
    const markdown = detectAndConvertPdfStructure(rawText);
    if (markdown !== null) {
      return { plainText: markdown, format: "markdown" };
    }
    return { plainText: rawText, format: "plain" };
  }

  return null;
}

async function markSearchUnsupported(version: { id: string; workspaceId: string; mimeType: string }) {
  await prisma.documentSearch.upsert({
    where: { versionId: version.id },
    update: {
      status: "unsupported",
      plainText: null,
      error: `Unsupported mime type: ${version.mimeType}`,
    },
    create: {
      versionId: version.id,
      workspaceId: version.workspaceId,
      status: "unsupported",
      plainText: null,
      error: `Unsupported mime type: ${version.mimeType}`,
    },
  });
}

async function markSearchFailed(
  version: { id: string; workspaceId: string },
  message: string
) {
  await prisma.documentSearch.upsert({
    where: { versionId: version.id },
    update: {
      status: "failed",
      plainText: null,
      error: message,
    },
    create: {
      versionId: version.id,
      workspaceId: version.workspaceId,
      status: "failed",
      plainText: null,
      error: message,
    },
  });
}

async function markSearchIndexed(
  version: { id: string; workspaceId: string },
  plainText: string,
  format: "plain" | "markdown"
) {
  await prisma.documentSearch.upsert({
    where: { versionId: version.id },
    update: {
      status: "indexed",
      plainText,
      format,
      error: null,
    },
    create: {
      versionId: version.id,
      workspaceId: version.workspaceId,
      status: "indexed",
      plainText,
      format,
      error: null,
    },
  });
}

async function indexDocumentVersion(payload: unknown) {
  const { versionId, workspaceId, documentId } =
    parseIndexDocumentVersionPayload(payload);

  const version = await prisma.documentVersion.findFirst({
    where: {
      id: versionId,
      workspaceId,
      documentId,
    },
    select: {
      id: true,
      workspaceId: true,
      documentId: true,
      sha256: true,
      mimeType: true,
    },
  });

  if (!version) {
    throw new Error(`Document version not found: ${versionId}`);
  }

  if (!isTextMimeType(version.mimeType) && !isPdfMimeType(version.mimeType) && !isWordMimeType(version.mimeType)) {
    await markSearchUnsupported(version);
    return;
  }

  try {
    const result = await extractContent(version);

    if (result === null) {
      await markSearchUnsupported(version);
      return;
    }

    await markSearchIndexed(version, result.plainText, result.format);
  } catch (e: unknown) {
    await markSearchFailed(version, toErrorMessage(e));
  }
}

function toErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function loop() {
  let backoffMs = 1000;

  while (running) {
    let job;

    try {
      job = await claimNextJob();
    } catch (e: unknown) {
      console.error("Failed to claim job:", toErrorMessage(e));
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 30_000);
      continue;
    }

    backoffMs = 1000; // reset backoff on successful DB contact

    if (!job) {
      // nothing to do; sleep a bit
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }

    console.log("Claimed job", job.id, job.type);

    try {
      await runJob(job);
      console.log("Completed job", job.id);
    } catch (e: unknown) {
      const message = toErrorMessage(e);
      console.error("Job failed", job.id, message);
      const isDead = job.attempts >= job.maxAttempts;
      const retryDelayMs = Math.min(2 ** Math.max(job.attempts - 1, 0) * 1000, 5 * 60 * 1000);
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: isDead ? "dead" : "queued",
          runAt: isDead ? undefined : new Date(Date.now() + retryDelayMs),
          lockedAt: null,
          lockedBy: null,
          lastError: message,
        },
      });
    }
  }

  console.log("Worker loop exited.");
}

async function main() {
  await prisma.$queryRaw`SELECT 1`;
  console.log("Worker alive + DB reachable as", WORKER_ID);
  await loop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
