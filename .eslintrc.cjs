module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true,
    node: true,
    webextensions: true,
  },
  extends: ["eslint:recommended"],
  ignorePatterns: ["dist/", "node_modules/", "web-ext-artifacts/"],
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
  rules: {
    "no-console": "off",
  },
};
