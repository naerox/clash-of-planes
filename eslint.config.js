import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["dist"] },
  js.configs.recommended,
  {
    files: ["src/**/*.js"],
    languageOptions: { sourceType: "module", globals: globals.browser },
    rules: { "no-var": "error", "prefer-const": "error", eqeqeq: "error" },
  },
  {
    // tests run in Node, not in the browser
    files: ["src/**/*.test.js"],
    languageOptions: { globals: globals.node },
  },
  {
    // build scripts and the dev-server middleware run in Node
    files: ["scripts/**/*.js", "server/**/*.js", "vite.config.js"],
    languageOptions: { sourceType: "module", globals: globals.node },
  },
];
