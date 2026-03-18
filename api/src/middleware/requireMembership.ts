import { Request, Response, NextFunction } from "express";
import { prisma } from "@archive/db";
import { ForbiddenError } from "./errorHandler";

export async function requireMembership(req: Request, _res: Response, next: NextFunction) {
const workspaceId = req.params.workspaceId as string;

  const membership = await prisma.membership.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId,
        userId: req.user!.id,
      },
    },
  });

  if (!membership) {
    throw new ForbiddenError("Not a member of this workspace");
  }

  req.membership = {
    workspaceId: membership.workspaceId,
    userId: membership.userId,
    role: membership.role,
  };

  next();
}