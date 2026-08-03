import dotenv from "dotenv";

dotenv.config({ path: `${__dirname}/../../.env` });

import { prisma } from "@archive/db";
import { getBlob } from "@archive/storage";
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
      data: { status: "succeeded" },
    });
    return;
  }

  if (job.type === "INDEX_DOCUMENT_VERSION") {
    await indexDocumentVersion(job.payload);
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "succeeded" },
    });
    return;
  }

  // Unknown job type
  await prisma.job.update({
    where: { id: job.id },
    data: {
      status: "failed",
      lastError: `Unknown job type: ${job.type}`,
    },
  });
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

async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function isTextMimeType(mimeType: string) {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType.endsWith("+json")
  );
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

  if (!isTextMimeType(version.mimeType)) {
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
    return;
  }

  const stream = await getBlob(version.sha256);
  const plainText = await streamToString(stream);

  await prisma.documentSearch.upsert({
    where: { versionId: version.id },
    update: {
      status: "indexed",
      plainText,
      error: null,
    },
    create: {
      versionId: version.id,
      workspaceId: version.workspaceId,
      status: "indexed",
      plainText,
      error: null,
    },
  });
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
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: isDead ? "dead" : "failed",
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
