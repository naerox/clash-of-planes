import { defineConfig } from "@playwright/test";

// The end-to-end suite drives REAL browsers against the REAL server (which serves the built
// client from client/dist — run `npm run build` first). `webServer` starts it and waits for /health.
const PORT = 3100;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  webServer: {
    command: "node server/src/index.ts",
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: false,
    timeout: 20_000,
    env: {
      PORT: String(PORT),
      HOST: "127.0.0.1",
      LOG_DIR: ".e2e-logs",
      CLIENT_DIST: "client/dist",
      NODE_ENV: "development",
    },
  },
});
