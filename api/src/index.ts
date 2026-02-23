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