import { defineConfig } from "vite";
import { devFaults } from "./dev/faults.ts";

// In development Vite serves the client and forwards /api and /ws to the Node server
// (server/, Lab 4). In production the Node server serves client/dist itself.
const target = process.env.SERVER_URL ?? "http://127.0.0.1:3000";

// What is running, stamped at build time (the Docker build passes both): shown in a corner of the
// page next to the SERVER's own version from /health, so a stale tab or a half-finished deploy shows.
const version = process.env.APP_VERSION ?? "dev";
const gitSha = process.env.GIT_SHA ?? "unknown";

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __GIT_SHA__: JSON.stringify(gitSha),
  },
  plugins: [devFaults()],
  server: {
    proxy: {
      "/api": target,
      "/ws": { target, ws: true },
    },
  },
  preview: {
    proxy: {
      "/api": target,
      "/ws": { target, ws: true },
    },
  },
});
