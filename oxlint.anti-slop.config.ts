import { defineConfig } from "oxlint";

// This config runs only the vendored anti-slop plugin, through `bun run deslop`
// and the ratchet in `bun run check:changed`. The general-purpose lint is
// `oxlint.config.ts`, run by `bun run lint`.
export default defineConfig({
  categories: {
    correctness: "off",
  },
  ignorePatterns: [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/out/**",
    "**/.next/**",
    "**/ios/**",
    "**/android/**",
    ".agents/**",
    ".claude/**",
    ".conductor/**",
    ".opencode/**",
    ".openchamber/**",
    ".tmp/**",
    // Bundles built from the TypeScript sources beside them; the sources are linted.
    "packages/sdk/examples/**/*.js",
    "patches/**",
    "bun-patches/**",
    "tools/oxlint/**",
  ],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
  ],
  rules: {
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
  },
});
