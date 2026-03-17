import jwt from "jsonwebtoken";
import { randomBytes, createHash } from "crypto";

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET!;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET!;

const ACCESS_EXPIRES_IN = "15m";
const REFRESH_EXPIRES_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// --- Access token ---

interface AccessPayload {
  userId: string;
}

export function signAccessToken(userId: string): string {
  return jwt.sign({ userId }, ACCESS_SECRET, { expiresIn: ACCESS_EXPIRES_IN });
}

export function verifyAccessToken(token: string): AccessPayload {
  return jwt.verify(token, ACCESS_SECRET) as AccessPayload;
}

// --- Refresh token ---

export function generateRefreshToken(): string {
  return randomBytes(64).toString("hex");
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function getRefreshExpiresAt(): Date {
  return new Date(Date.now() + REFRESH_EXPIRES_MS);
}