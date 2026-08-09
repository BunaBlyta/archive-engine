// Env vars with no safe default anywhere in the codebase. PORT, WEB_ORIGINS,
// ONLYOFFICE_URL, EDITOR_PUBLIC_API_URL, and the MINIO_* vars all fall back to a
// working local value and are intentionally left out. DATABASE_URL has no fallback either —
// Prisma reads it lazily, so leaving it unchecked here would let a missing value surface as a
// PrismaClientInitializationError on the first query in production instead of at boot.
const REQUIRED_ENV_VARS = ["DATABASE_URL", "JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET", "ONLYOFFICE_JWT_SECRET"] as const;

export function assertRequiredEnv(): void {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }
}
