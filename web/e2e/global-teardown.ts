import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { WORKER_PID_FILE } from "./global-setup";

// Kills the process group: `npm run dev:worker` spawns the worker as a child, so killing only the
// npm wrapper would leave the worker running after the suite exits.
export default async function globalTeardown() {
  if (!existsSync(WORKER_PID_FILE)) return;

  const pid = Number(readFileSync(WORKER_PID_FILE, "utf8").trim());
  unlinkSync(WORKER_PID_FILE);

  if (!Number.isInteger(pid) || pid <= 0) return;

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // Already gone, or never started.
  }
}
