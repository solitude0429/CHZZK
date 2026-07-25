import js from "@eslint/js";
import globals from "globals";

const common = {
  ...js.configs.recommended,
  files: ["**/*.{js,mjs,cjs}"],
  languageOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
  rules: {
    ...js.configs.recommended.rules,
    "no-console": "off",
    "no-useless-assignment": "off",
    "preserve-caught-error": "off",
  },
};

export default [
  {
    ignores: ["codex-security-scans/", "dist/", "node_modules/", "web-ext-artifacts/"],
  },
  common,
  {
    files: ["**/*.cjs"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: globals.node,
      sourceType: "commonjs",
    },
  },
  {
    files: ["src/runtime/**/*.js", "background.js", "diagnostics.js", "site-observer.js"],
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
    files: ["scripts/**/*.js", "tests/**/*.js", "tests/**/*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
  },
];
