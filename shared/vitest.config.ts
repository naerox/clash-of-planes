import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "shared",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/index.ts"], // index.ts only re-exports
      reporter: ["text-summary", "text", "json-summary"],
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 80 },
    },
  },
});
