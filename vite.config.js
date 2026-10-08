import { defineConfig } from "vite";
import { devApi } from "./server/devApi.js";

export default defineConfig({
  plugins: [devApi()],
});
