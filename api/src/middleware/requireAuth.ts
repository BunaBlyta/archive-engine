import { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "../lib/auth";
import { UnauthorizedError } from "./errorHandler";
import { prisma } from "@archive/db";

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    throw new UnauthorizedError("Missing or malformed Authorization header");
  }

  const token = header.slice(7);

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    throw new UnauthorizedError("Invalid or expired access token");
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { id: true, email: true },
  });

  if (!user) {
    throw new UnauthorizedError("User no longer exists");
  }

  req.user = user;
  next();
}