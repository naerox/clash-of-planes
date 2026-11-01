import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const rules = {
  "no-var": "error",
  "prefer-const": "error",
  eqeqeq: "error",
  "@typescript-eslint/no-explicit-any": "error",
};

export default [
  { ignores: ["**/dist", "**/node_modules", "logs"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
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
      "client/src/**/*.test.ts",
    ],
    languageOptions: { sourceType: "module", globals: globals.node },
    rules,
  },
];
