import { Router } from "express";
import { prisma } from "@archive/db";

const router = Router();

router.post("/ping", async (_req, res) => {
  const job = await prisma.job.create({
    data: {
      type: "PING",
      payload: { message: "hello" },
    },
  });

  res.json({ ok: true, jobId: job.id });
});

router.get("/latest", async (_req, res) => {
  const jobs = await prisma.job.findMany({
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { id: true, type: true, status: true, createdAt: true },
  });

  res.json({ ok: true, jobs });
});

export default router;