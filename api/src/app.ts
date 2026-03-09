import express from "express";
import pinoHttp from "pino-http";
import { requestId } from "./middleware/requestId";
import { errorHandler } from "./middleware/errorHandler";
import healthRouter from "./routes/health";
import jobsRouter from "./routes/jobs";

export function createApp() {
  const app = express();

  app.use(express.json());
  app.use(requestId);
  app.use(pinoHttp({
    genReqId: (req) => req.id,
  }));

  app.use("/health", healthRouter);
  app.use("/jobs", jobsRouter);

  app.use(errorHandler);

  return app;
}