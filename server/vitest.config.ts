import { defineConfig } from "vitest/config";

// The server tests start real servers on random ports; a few assert on timing, so files run one
// after another in separate processes rather than all at once on a busy machine.
export default defineConfig({
  test: {
    name: "server",
    include: ["test/**/*.test.ts"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
