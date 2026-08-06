import express from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { requestId } from "./middleware/requestId";
import { errorHandler } from "./middleware/errorHandler";
import healthRouter from "./routes/health";
import cookieParser from "cookie-parser";
import authRouter from "./routes/auth";
import workspacesRouter from "./routes/workspaces";
import editorRouter from "./routes/editor";

export function createApp() {
  const app = express();
  const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173";

  app.use(cors({
    origin: webOrigin,
    credentials: true,
  }));
  app.use(requestId);
  app.use(pinoHttp({
    genReqId: (req) => req.id,
  }));
  app.use(express.json({ limit: "25mb" }));
  app.use(cookieParser());

  app.use("/health", healthRouter);
  app.use("/v1/auth", authRouter);
  app.use("/v1/editor", editorRouter);
  app.use("/v1/workspaces", workspacesRouter);
  app.use(errorHandler);

  return app;
}
