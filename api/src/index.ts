import dotenv from "dotenv";

dotenv.config({ path: `${__dirname}/../../.env` });

import { createApp } from "./app";

const PORT = process.env.PORT ?? 3000;

const app = createApp();

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down server...");
  server.close(() => {
    console.log("Server closed.");
    process.exit(0);
  });
});
