import dotenv from "dotenv";
import path from "path";

dotenv.config({
  path: path.resolve(__dirname, "../../.env"),
});
import express from "express";
import { prisma } from "@archive/db";

const app = express();

app.get("/", (_req, res) => {
  res.json({ message: "Archive Engine API running" });
});

app.get("/health/db", async (_req, res) => {
  await prisma.$queryRaw`SELECT 1`;
  res.json({ ok: true, db: "up" });
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});

app.post("/jobs/ping", async (_req, res) => {
  const job = await prisma.job.create({
    data: {
      type: "PING",
      payload: { message: "hello" }
    }
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
