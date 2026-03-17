import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcrypt";
import { prisma } from "@archive/db";
import {
  signAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  getRefreshExpiresAt,
} from "../lib/auth";
import {
  ConflictError,
  UnauthorizedError,
  ValidationError,
} from "../middleware/errorHandler";
const router = Router();

// --- Register ---

const registerSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

router.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);

  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0].message);
  }

  const { email, password } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });

  if (existing) {
    throw new ConflictError("Email already registered");
  }

  const hashedPassword = await bcrypt.hash(password, 12);

  const user = await prisma.user.create({
    data: {
      email,
      password: hashedPassword,
    },
  });

  const accessToken = signAccessToken(user.id);
  const refreshToken = generateRefreshToken();

  await prisma.session.create({
    data: {
      userId: user.id,
      refreshTokenHash: hashRefreshToken(refreshToken),
      expiresAt: getRefreshExpiresAt(),
      ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null,
    },
  });

  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/v1/auth",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });

  res.status(201).json({
    ok: true,
    data: {
      accessToken,
      user: { id: user.id, email: user.email },
    },
  });
});

// --- Login ---

const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

router.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);

  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0].message);
  }

  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    throw new UnauthorizedError("Invalid email or password");
  }

  const passwordMatch = await bcrypt.compare(password, user.password);

  if (!passwordMatch) {
    throw new UnauthorizedError("Invalid email or password");
  }

  const accessToken = signAccessToken(user.id);
  const refreshToken = generateRefreshToken();

  await prisma.session.create({
    data: {
      userId: user.id,
      refreshTokenHash: hashRefreshToken(refreshToken),
      expiresAt: getRefreshExpiresAt(),
      ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null,
    },
  });

  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/v1/auth",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });

  res.json({
    ok: true,
    data: {
      accessToken,
      user: { id: user.id, email: user.email },
    },
  });
});

// --- Refresh ---

router.post("/refresh", async (req, res) => {
  const token = req.cookies?.refreshToken;

  if (!token) {
    throw new UnauthorizedError("No refresh token provided");
  }

  const tokenHash = hashRefreshToken(token);

  const session = await prisma.session.findUnique({
    where: { refreshTokenHash: tokenHash },
  });

  if (!session) {
    // Token doesn't match any session — possible reuse of a rotated token
    // Try to find if this token was already rotated (a new session replaced it)
    // If so, someone may have stolen the old token — revoke everything for safety
    const rotatedSession = await prisma.session.findFirst({
      where: { rotatedFromId: { not: null } },
      orderBy: { createdAt: "desc" },
    });

    // We can't reliably trace back from a hashed token that no longer exists,
    // but if a token is completely unknown, the safest move is to reject it.
    throw new UnauthorizedError("Invalid refresh token");
  }

  if (session.revokedAt) {
    // This session was explicitly revoked — someone may be reusing a stolen token
    // Revoke ALL sessions for this user as a precaution
    await prisma.session.deleteMany({
      where: { userId: session.userId },
    });

    res.clearCookie("refreshToken", { path: "/v1/auth" });
    throw new UnauthorizedError("Session was revoked — all sessions invalidated");
  }

  if (session.expiresAt < new Date()) {
    await prisma.session.delete({ where: { id: session.id } });
    res.clearCookie("refreshToken", { path: "/v1/auth" });
    throw new UnauthorizedError("Refresh token expired");
  }

  // Rotation: delete old session, create new one
  const newRefreshToken = generateRefreshToken();

  await prisma.session.delete({ where: { id: session.id } });

  await prisma.session.create({
    data: {
      userId: session.userId,
      refreshTokenHash: hashRefreshToken(newRefreshToken),
      rotatedFromId: session.id,
      expiresAt: getRefreshExpiresAt(),
      ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null,
    },
  });

  const accessToken = signAccessToken(session.userId);

  res.cookie("refreshToken", newRefreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/v1/auth",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });

  res.json({
    ok: true,
    data: { accessToken },
  });
});

// --- Logout ---

router.post("/logout", async (req, res) => {
  const token = req.cookies?.refreshToken;

  if (token) {
    const tokenHash = hashRefreshToken(token);

    await prisma.session.deleteMany({
      where: { refreshTokenHash: tokenHash },
    });
  }

  res.clearCookie("refreshToken", { path: "/v1/auth" });

  res.json({ ok: true });
});

export default router;
