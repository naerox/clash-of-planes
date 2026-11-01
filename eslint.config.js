import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const rules = {
  "no-var": "error",
  "prefer-const": "error",
  eqeqeq: "error",
  "@typescript-eslint/no-explicit-any": "error",
  // a promise nobody awaits swallows its error — in a server that means a silent crash-in-waiting
  "@typescript-eslint/no-floating-promises": "error",
  "@typescript-eslint/no-misused-promises": "error",
};

export default [
  { ignores: ["**/dist", "**/node_modules", "logs"] },
  js.configs.recommended,
  // Type-checked rules: they read the real types, so they catch what a syntax-only linter cannot —
  // a floating promise, an `await` of a non-promise, an unsafe `any` flowing in from a library.
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({ ...config, files: ["**/*.ts"] })),
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        // a file belongs to the FIRST of these projects that includes it
        project: [
          "shared/tsconfig.json",
          "shared/tsconfig.test.json",
          "client/tsconfig.json",
          "server/tsconfig.json",
          "server/tsconfig.test.json",
          "tsconfig.tools.json",
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // shared/src runs in BOTH the browser and Node, so it gets neither environment's globals:
    // only the language itself (+ TextEncoder/Decoder, which both runtimes provide). A stray
    // `window`, `process`, `console`, `setTimeout` or `performance` is a lint error (no-undef).
    files: ["shared/src/**/*.ts"],
    languageOptions: {
      sourceType: "module",
      globals: { ...globals.es2021, TextEncoder: "readonly", TextDecoder: "readonly" },
    },
    rules,
  },
  {
    // the browser client
    files: ["client/src/**/*.ts"],
    languageOptions: { sourceType: "module", globals: globals.browser },
    rules,
  },
  {
    // the Node server, its scripts and tests, plus build/dev tooling: all run in Node
    files: [
      "server/**/*.ts",
      "shared/test/**/*.ts",
      "shared/scripts/**/*.ts",
      "client/scripts/**/*.ts",
      "client/dev/**/*.ts",
      "client/vite.config.ts",
      "tools/**/*.ts",
      "e2e/**/*.ts",
      "*.config.ts",
      "*/vitest.config.ts",
      "client/src/**/*.test.ts",
    ],
    languageOptions: { sourceType: "module", globals: globals.node },
    rules,
  },
];
