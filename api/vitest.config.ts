import { defineConfig } from "vitest/config";
import { config } from "dotenv";

// The integration tests need DATABASE_URL and the JWT secrets, which live in the repo-root
// .env rather than api/.env. Load it here so `npx vitest run` works from any directory
// instead of requiring the caller to source it first. dotenv does not override variables
// already present, so a real environment (CI) still wins.
config({ path: new URL("../.env", import.meta.url).pathname });

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
