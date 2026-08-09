import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

export const WORKER_PID_FILE = resolve(tmpdir(), "archive-engine-web-e2e-worker.pid");

// Search only returns results once the worker has indexed a published version. The worker cannot
// be a Playwright `webServer` entry because it has no HTTP port to poll, and it cannot ride along
// with the API entry either: with reuseExistingServer, an API already listening on :3000 means
// that command never runs. Spawning it here works whatever is already running — and a second
// worker alongside a developer's own is harmless, because job claiming is an atomic conditional
// update, so two workers cannot take the same job.
export default async function globalSetup() {
  const repoRoot = resolve(process.cwd(), "..");
  const worker = spawn("npm", ["run", "dev:worker"], {
    cwd: repoRoot,
    stdio: "ignore",
    detached: true,
  });

  worker.unref();

  if (worker.pid) {
    writeFileSync(WORKER_PID_FILE, String(worker.pid), "utf8");
  }
}
