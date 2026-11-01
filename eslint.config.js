import js from "@eslint/js";
import globals from "globals";

const rules = { "no-var": "error", "prefer-const": "error", eqeqeq: "error" };

export default [
  { ignores: ["**/dist", "**/node_modules", "logs"] },
  js.configs.recommended,
  {
    // shared/src runs in BOTH the browser and Node, so it gets neither environment's globals:
    // only the language itself (+ TextEncoder/Decoder, which both runtimes provide). A stray
    // `window`, `process`, `console`, `setTimeout` or `performance` is a lint error (no-undef).
    files: ["shared/src/**/*.js"],
    languageOptions: {
      sourceType: "module",
      globals: { ...globals.es2021, TextEncoder: "readonly", TextDecoder: "readonly" },
    },
    rules,
  },
  {
    // the browser client
    files: ["client/src/**/*.js"],
    languageOptions: { sourceType: "module", globals: globals.browser },
    rules,
  },
  {
    // the Node server, its scripts and tests, plus build/dev tooling: all run in Node
    files: [
      "server/**/*.js",
      "shared/test/**/*.js",
      "shared/scripts/**/*.js",
      "client/scripts/**/*.js",
      "client/dev/**/*.js",
      "client/vite.config.js",
      "client/src/**/*.test.js",
    ],
    languageOptions: { sourceType: "module", globals: globals.node },
    rules,
  },
];
