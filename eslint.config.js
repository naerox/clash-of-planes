import js from "@eslint/js";
import globals from "globals";

const rules = { "no-var": "error", "prefer-const": "error", eqeqeq: "error" };

export default [
  { ignores: ["**/dist", "**/node_modules", "logs"] },
  js.configs.recommended,
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
      "client/scripts/**/*.js",
      "client/dev/**/*.js",
      "client/vite.config.js",
      "client/src/**/*.test.js",
    ],
    languageOptions: { sourceType: "module", globals: globals.node },
    rules,
  },
];
