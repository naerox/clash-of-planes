import { defineConfig } from "vite";
import { devFaults } from "./dev/faults.js";

// In development Vite serves the client and forwards /api and /ws to the Node server
// (server/, Lab 4). In production the Node server serves client/dist itself.
const target = process.env.SERVER_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
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
