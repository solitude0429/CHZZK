module.exports = {
  root: true,
  extends: ["eslint:recommended"],
  ignorePatterns: ["dist/", "node_modules/", "web-ext-artifacts/"],
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
  overrides: [
    {
      files: ["*.cjs"],
      env: { es2022: true, node: true },
    },
    {
      files: ["src/runtime/**/*.js", "background.js", "diagnostics.js", "site-observer.js"],
      env: { browser: true, es2022: true, webextensions: true },
    },
    {
      files: ["src/shared/**/*.js"],
      env: { browser: true, es2022: true },
    },
    {
      files: ["scripts/**/*.js", "tests/**/*.js"],
      env: { es2022: true, node: true },
    },
  ],
  rules: {
    "no-console": "off",
  },
};
