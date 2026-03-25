import { Router } from "express";
import { z } from "zod";
import { prisma } from "@archive/db";
import { requireAuth } from "../middleware/requireAuth";
import {
  ValidationError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
} from "../middleware/errorHandler";
import { requireMembership } from "../middleware/requireMembership";

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

// --- Add member ---

const addMemberSchema = z.object({
  email: z.string().email("Invalid email address"),
  role: z.enum(["member", "admin"]).default("member"),
});

router.post("/:workspaceId/members", requireMembership, async (req, res) => {
  if (req.membership!.role !== "admin") {
    throw new ForbiddenError("Only admins can add members");
  }

  const parsed = addMemberSchema.safeParse(req.body);

  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0].message);
  }

  const { email, role } = parsed.data;

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  });

  if (!user) {
    throw new NotFoundError("No user found with that email");
  }

  const existing = await prisma.membership.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId: req.membership!.workspaceId,
        userId: user.id,
      },
    },
  });

  if (existing) {
    throw new ConflictError("User is already a member of this workspace");
  }

  const membership = await prisma.membership.create({
    data: {
      workspaceId: req.membership!.workspaceId,
      userId: user.id,
      role,
    },
  });

  res.status(201).json({
    ok: true,
    data: {
      member: {
        userId: membership.userId,
        email: user.email,
        role: membership.role,
        createdAt: membership.createdAt.toISOString(),
      },
    },
  });
});

export default router;