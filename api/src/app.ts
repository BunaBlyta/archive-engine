import express from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { requestId } from "./middleware/requestId";
import { errorHandler, NotFoundError } from "./middleware/errorHandler";
import { authLimiter, globalLimiter } from "./middleware/rateLimit";
import healthRouter from "./routes/health";
import cookieParser from "cookie-parser";
import authRouter from "./routes/auth";
import workspacesRouter from "./routes/workspaces";
import editorRouter from "./routes/editor";

// Every route accepts JSON bodies, but none of them legitimately need a large one — uploads
// (which can be large) go through multer's multipart handling, not this parser. Keep this
// small so a bloated JSON body can't be used to tie up the event loop or memory.
const JSON_BODY_LIMIT = "100kb";

// One exception: a draft's full text is PATCHed as a JSON body, and documents can be uploaded at
// up to multer's 25MB cap, so a large Markdown or plain-text document would 413 under the limit
// above. Rather than raise it everywhere, this single authenticated, membership-checked route
// gets its own parser. Keep the two limits in sync with multer's if that ever changes.
const DRAFT_CONTENT_BODY_LIMIT = "25mb";
const DRAFT_CONTENT_PATH = /^\/v1\/workspaces\/[^/]+\/documents\/[^/]+\/drafts\/[^/]+$/;

export function createApp() {
  const app = express();
  const webOrigins = (process.env.WEB_ORIGINS ?? "http://localhost:5173,http://localhost:3001")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  // Trusts a configurable number of hops in front of the app (e.g. a single reverse proxy) so
  // req.ip resolves to the real client address instead of the proxy's. 0 (the default) means
  // "no proxy — trust nothing but the direct socket," matching today's deployment; set
  // TRUST_PROXY_HOPS when a proxy/load balancer is introduced.
  const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? "0");
  app.set("trust proxy", Number.isFinite(trustProxyHops) && trustProxyHops > 0 ? trustProxyHops : false);

  app.use(
    helmet({
      // This API serves file downloads to be viewed/downloaded by a separate browser origin, and
      // is not itself serving HTML/JS that needs a CSP. The defaults are built for a same-origin
      // HTML app: CORP would block cross-origin fetches of downloaded files, and CSP has no
      // purpose here but can interfere with clients rendering/consuming JSON and file responses.
      crossOriginResourcePolicy: { policy: "cross-origin" },
      contentSecurityPolicy: false,
    })
  );
  app.use(cors({
    origin: webOrigins,
    credentials: true,
  }));
  app.use(requestId);
  app.use(pinoHttp({
    genReqId: (req) => req.id,
  }));
  app.use(globalLimiter);
  const standardJson = express.json({ limit: JSON_BODY_LIMIT });
  const draftContentJson = express.json({ limit: DRAFT_CONTENT_BODY_LIMIT });

  app.use((req, res, next) => {
    if (req.method === "PATCH" && DRAFT_CONTENT_PATH.test(req.path)) {
      draftContentJson(req, res, next);
      return;
    }

    standardJson(req, res, next);
  });
  app.use(cookieParser());

  app.use("/health", healthRouter);
  app.use("/v1/auth", authLimiter, authRouter);
  app.use("/v1/editor", editorRouter);
  app.use("/v1/workspaces", workspacesRouter);

  app.use((req, _res, next) => {
    next(new NotFoundError(`No route matches ${req.method} ${req.originalUrl}`));
  });

  app.use(errorHandler);

  return app;
}
