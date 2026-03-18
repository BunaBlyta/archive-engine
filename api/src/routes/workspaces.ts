import { Router } from "express";
import { z } from "zod";
import { prisma } from "@archive/db";
import { requireAuth } from "../middleware/requireAuth";
import { ValidationError } from "../middleware/errorHandler";

const router = Router();

router.use(requireAuth);

// --- Create workspace ---

const createWorkspaceSchema = z.object({
  name: z.string().min(1, "Workspace name is required").max(100, "Workspace name too long"),
});

router.post("/", async (req, res) => {
  const parsed = createWorkspaceSchema.safeParse(req.body);

  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0].message);
  }

  const { name } = parsed.data;

  const workspace = await prisma.$transaction(async (tx) => {
    const ws = await tx.workspace.create({
      data: { name },
    });

    await tx.membership.create({
      data: {
        workspaceId: ws.id,
        userId: req.user!.id,
        role: "admin",
      },
    });

    return ws;
  });

  res.status(201).json({
    ok: true,
    data: {
      workspace: {
        id: workspace.id,
        name: workspace.name,
        createdAt: workspace.createdAt.toISOString(),
      },
    },
  });
});

// --- List workspaces ---

router.get("/", async (req, res) => {
  const memberships = await prisma.membership.findMany({
    where: { userId: req.user!.id },
    include: {
      workspace: {
        select: { id: true, name: true, createdAt: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const workspaces = memberships.map((m) => ({
    id: m.workspace.id,
    name: m.workspace.name,
    role: m.role,
    createdAt: m.workspace.createdAt.toISOString(),
  }));

  res.json({
    ok: true,
    data: { workspaces },
  });
});

export default router;