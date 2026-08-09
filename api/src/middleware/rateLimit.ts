import rateLimit from "express-rate-limit";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

// The limits below are a production security control, but the same process runs locally, where
// one Playwright run registers a dozen users and a developer may run the suite several times
// inside a single window. A limit that a normal dev loop exhausts is a limit someone eventually
// deletes, so outside production the ceilings are raised far beyond anything a person or a test
// run reaches. Both are overridable by env so the production values can be tuned without a deploy.
const isProduction = process.env.NODE_ENV === "production";

function limitFromEnv(name: string, productionDefault: number, developmentDefault: number) {
  const raw = process.env[name];
  const parsed = raw === undefined ? NaN : Number(raw);

  if (Number.isFinite(parsed) && parsed > 0) return parsed;

  return isProduction ? productionDefault : developmentDefault;
}

// Login/register/refresh are the highest-value target for credential stuffing and account
// enumeration. 100 per 15 minutes per IP is well under 10/minute sustained — enough to make
// automated password guessing impractically slow, with headroom for a real user retrying a
// typo'd password.
const AUTH_MAX_REQUESTS = limitFromEnv("AUTH_RATE_LIMIT_MAX", 100, 10_000);

// Everything else: a loose backstop against outright abuse, not a control against any specific
// attack.
const GLOBAL_MAX_REQUESTS = limitFromEnv("GLOBAL_RATE_LIMIT_MAX", 2000, 100_000);

export const authLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES_MS,
  limit: AUTH_MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
});

export const globalLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES_MS,
  limit: GLOBAL_MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
});
