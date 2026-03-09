import { PrismaClient } from "../generated/client";

export const prisma = new PrismaClient();

process.on("beforeExit", async () => {
  await prisma.$disconnect();
});
