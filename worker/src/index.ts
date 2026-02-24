import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { prisma } from "@archive/db";

const WORKER_ID = `worker-${process.pid}`;

const LOCK_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

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
    select: { id: true, type: true },
  });

  if (!candidate) return null;

  // Try to claim it atomically: only succeeds if it’s still claimable
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

  // Return minimal job info for processing
  return { id: candidate.id, type: candidate.type };
}
async function runJob(job: { id: string; type: string }) {
  if (job.type === "PING") {
    // pretend work
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

async function loop() {
  while (true) {
    const job = await claimNextJob();

    if (!job) {
      // nothing to do; sleep a bit
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }

    console.log("Claimed job", job.id, job.type);

    try {
      await runJob(job);
      console.log("Completed job", job.id);
    } catch (e: any) {
      console.error("Job failed", job.id, e?.message ?? e);
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: "failed",
          lastError: String(e?.message ?? e),
        },
      });
    }
  }
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