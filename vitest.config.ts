import { defineConfig } from "vitest/config";

// One `npm test` at the root runs the three packages as Vitest "projects" (each has its own
// vitest.config.ts: where its tests live and how they run).
export default defineConfig({
  test: { projects: ["shared", "client", "server"] },
});
