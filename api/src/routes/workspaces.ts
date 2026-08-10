import { Request, Router } from "express";
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
import documentsRouter from "./documents";

const router = Router();

router.use(requireAuth);

function parsePagination(req: Request) {
  const rawLimit = typeof req.query.limit === "string" ? req.query.limit : undefined;
  const rawOffset = typeof req.query.offset === "string" ? req.query.offset : undefined;
  const limit = rawLimit === undefined ? 25 : Number(rawLimit);
  const offset = rawOffset === undefined ? 0 : Number(rawOffset);

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ValidationError("Limit must be an integer between 1 and 100");
  }

  if (!Number.isInteger(offset) || offset < 0) {
    throw new ValidationError("Offset must be a non-negative integer");
  }

  return { limit, offset };
}

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

// --- List audit logs ---

router.get("/:workspaceId/audit-logs", requireMembership, async (req, res) => {
  const { limit, offset } = parsePagination(req);

  const logs = await prisma.auditLog.findMany({
    where: {
      workspaceId: req.membership!.workspaceId,
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    skip: offset,
    select: {
      id: true,
      action: true,
      entityType: true,
      entityId: true,
      actorId: true,
      ip: true,
      userAgent: true,
      metadata: true,
      createdAt: true,
      actor: {
        select: {
          email: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  });

  // Almost every entry records which document it concerns, but only as an id buried in metadata,
  // so the activity log read as a list of actions with no subject. Resolve the titles in one
  // query and hand them to the client.
  const documentIds = new Set<string>();
  for (const log of logs) {
    if (log.entityType === "document") documentIds.add(log.entityId);

    const documentId = (log.metadata as { documentId?: unknown } | null)?.documentId;
    if (typeof documentId === "string") documentIds.add(documentId);
  }

  const documents =
    documentIds.size > 0
      ? await prisma.document.findMany({
          where: { id: { in: [...documentIds] }, workspaceId: req.membership!.workspaceId },
          select: { id: true, title: true },
        })
      : [];

  const titleById = new Map(documents.map((document) => [document.id, document.title]));

  function documentRefFor(log: (typeof logs)[number]) {
    const fromMetadata = (log.metadata as { documentId?: unknown } | null)?.documentId;
    const id =
      log.entityType === "document"
        ? log.entityId
        : typeof fromMetadata === "string"
          ? fromMetadata
          : null;

    if (!id) return null;

    // A hard-deleted document leaves its log entries behind on purpose — the record of what
    // happened outlives the thing it happened to.
    const title = titleById.get(id);
    return title ? { id, title } : null;
  }

  res.json({
    ok: true,
    data: {
      pagination: {
        limit,
        offset,
        nextOffset: logs.length === limit ? offset + limit : null,
      },
      auditLogs: logs.map((log) => ({
        id: log.id,
        action: log.action,
        document: documentRefFor(log),
        entityType: log.entityType,
        entityId: log.entityId,
        actorId: log.actorId,
        actorEmail: log.actor?.email ?? null,
        actorFirstName: log.actor?.firstName ?? null,
        actorLastName: log.actor?.lastName ?? null,
        ip: log.ip,
        userAgent: log.userAgent,
        metadata: log.metadata,
        createdAt: log.createdAt.toISOString(),
      })),
    },
  });
});

router.use("/:workspaceId/documents", requireMembership, documentsRouter);

// --- List members ---

router.get("/:workspaceId/members", requireMembership, async (req, res) => {
  const members = await prisma.membership.findMany({
    where: {
      workspaceId: req.membership!.workspaceId,
    },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
        },
      },
    },
    orderBy: [
      { role: "asc" },
      { createdAt: "asc" },
    ],
  });

  res.json({
    ok: true,
    data: {
      members: members.map((member) => ({
        userId: member.user.id,
        email: member.user.email,
        firstName: member.user.firstName,
        lastName: member.user.lastName,
        role: member.role,
        createdAt: member.createdAt.toISOString(),
      })),
    },
  });
});

// --- Add member ---

const addMemberSchema = z.object({
  email: z.string().email("Invalid email address"),
  role: z.enum(["reviewer", "admin"]).default("reviewer"),
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
    select: { id: true, email: true, firstName: true, lastName: true },
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

  const audit = {
    ip: req.ip,
    userAgent: req.get("user-agent"),
  };

  const membership = await prisma.$transaction(async (tx) => {
    const created = await tx.membership.create({
      data: {
        workspaceId: req.membership!.workspaceId,
        userId: user.id,
        role,
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: req.membership!.workspaceId,
        actorId: req.user!.id,
        action: "membership.created",
        entityType: "membership",
        entityId: user.id,
        ip: audit.ip,
        userAgent: audit.userAgent,
        metadata: {
          email: user.email,
          role,
        },
      },
    });

    return created;
  });

  res.status(201).json({
    ok: true,
    data: {
      member: {
        userId: membership.userId,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: membership.role,
        createdAt: membership.createdAt.toISOString(),
      },
    },
  });
});

// --- Workspace dashboard ---

router.get("/:workspaceId/dashboard", requireMembership, async (req, res) => {
  const workspaceId = req.membership!.workspaceId;

  const [members, contributionGroups] = await Promise.all([
    prisma.membership.findMany({
      where: { workspaceId },
      include: {
        user: { select: { id: true, email: true, firstName: true, lastName: true } },
      },
      orderBy: [{ role: "asc" }, { createdAt: "asc" }],
    }),
    prisma.documentDraft.groupBy({
      by: ["proposedById"],
      where: { workspaceId, proposedById: { not: null } },
      _count: { id: true },
    }),
  ]);

  const countByUserId = new Map(
    contributionGroups.map((g) => [g.proposedById, g._count.id])
  );

  res.json({
    ok: true,
    data: {
      members: members.map((m) => ({
        userId: m.user.id,
        email: m.user.email,
        firstName: m.user.firstName,
        lastName: m.user.lastName,
        role: m.role,
        createdAt: m.createdAt.toISOString(),
        contributionCount: countByUserId.get(m.user.id) ?? 0,
      })),
    },
  });
});

export default router;
