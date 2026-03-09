import dotenv from "dotenv";

dotenv.config({ path: `${__dirname}/../../.env` });

import express from "express";
import { prisma } from "@archive/db";

const app = express();

app.get("/", (_req, res) => {
  res.json({ message: "Archive Engine API running" });
});

app.get("/health/db", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, db: "up" });
  } catch {
    res.status(500).json({ ok: false, db: "down" });
  }
});

app.post("/jobs/ping", async (_req, res) => {
  const job = await prisma.job.create({
    data: {
      type: "PING",
      payload: { message: "hello" },
    },
  });

  res.json({ ok: true, jobId: job.id });
});

app.get("/jobs/latest", async (_req, res) => {
  const jobs = await prisma.job.findMany({
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { id: true, type: true, status: true, createdAt: true },
  });

  res.json({ ok: true, jobs });
});

const PORT = process.env.PORT ?? 3000;

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down server...");
  server.close(() => {
    console.log("Server closed.");
    process.exit(0);
  });
});
