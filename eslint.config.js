import eslint from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["codex-security-scans/", "dist/", "node_modules/", "web-ext-artifacts/"],
  },
  eslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      "no-console": "off",
      "no-useless-assignment": "off",
      "preserve-caught-error": "off",
    },
  },
  {
    files: ["background.js", "diagnostics.js", "site-observer.js", "src/runtime/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.webextensions,
      },
    },
  },
  {
    files: ["src/shared/**/*.js"],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ["scripts/**/*.js", "tests/**/*.{js,mjs}"],
    languageOptions: {
      globals: globals.node,
    },
  },
];
