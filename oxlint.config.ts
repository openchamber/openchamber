import { defineConfig } from "oxlint";

// The repository's general-purpose lint, run by `bun run lint` and failing on
// any finding, and the config editors pick up by default.
// `oxlint.anti-slop.config.ts` is the separate anti-slop config, which keeps a
// backlog and is enforced only as a ratchet over changed files.
//
// The rule set is ESLint's and typescript-eslint's recommended sets plus the
// React hooks and fast-refresh rules, the set this repository linted with
// under ESLint.
const TYPESCRIPT_FILES = ["**/*.ts", "**/*.tsx"];

export default defineConfig({
  plugins: ["eslint", "typescript", "react"],
  jsPlugins: [
    { name: "openchamber", specifier: "./tools/oxlint/openchamber/index.ts" },
  ],
  categories: {
    correctness: "off",
  },
  ignorePatterns: [
    "**/node_modules/**",
    "**/dist/**",
    "**/ios/**",
    "**/android/**",
  ],
  overrides: [
    {
      files: TYPESCRIPT_FILES,
      rules: {
        "for-direction": "error",
        "no-async-promise-executor": "error",
        "no-case-declarations": "error",
        "no-compare-neg-zero": "error",
        "no-cond-assign": ["error", "except-parens"],
        "no-constant-binary-expression": "error",
        "no-constant-condition": ["error", { checkLoops: "allExceptWhileTrue" }],
        "no-control-regex": "error",
        "no-debugger": "error",
        "no-delete-var": "error",
        "no-dupe-else-if": "error",
        "no-duplicate-case": "error",
        "no-empty": "error",
        "no-empty-character-class": "error",
        "no-empty-pattern": "error",
        "no-empty-static-block": "error",
        "no-ex-assign": "error",
        "no-extra-boolean-cast": "error",
        "no-fallthrough": "error",
        "no-global-assign": "error",
        "no-invalid-regexp": "error",
        "no-irregular-whitespace": "error",
        "no-loss-of-precision": "error",
        "no-misleading-character-class": "error",
        "no-nonoctal-decimal-escape": "error",
        "no-prototype-builtins": "error",
        "no-regex-spaces": "error",
        "no-self-assign": ["error", { props: true }],
        "no-shadow-restricted-names": "error",
        "no-sparse-arrays": "error",
        "no-unexpected-multiline": "error",
        "no-unsafe-finally": "error",
        "no-unsafe-optional-chaining": "error",
        "no-unused-labels": "error",
        "no-unused-private-class-members": "error",
        "no-useless-backreference": "error",
        "no-useless-catch": "error",
        "no-useless-escape": "error",
        "require-yield": "error",
        "use-isnan": "error",
        "valid-typeof": "error",
        "no-var": "error",
        "prefer-const": "error",
        "prefer-rest-params": "error",
        "prefer-spread": "error",
        "no-unused-vars": "error",
        "no-unused-expressions": "error",
        "no-array-constructor": "error",
        "typescript/ban-ts-comment": "error",
        "typescript/no-duplicate-enum-values": "error",
        "typescript/no-empty-object-type": "error",
        "typescript/no-explicit-any": "error",
        "typescript/no-extra-non-null-assertion": "error",
        "typescript/no-misused-new": "error",
        "typescript/no-namespace": "error",
        "typescript/no-non-null-asserted-optional-chain": "error",
        "typescript/no-require-imports": "error",
        "typescript/no-this-alias": "error",
        "typescript/no-unnecessary-type-constraint": "error",
        "typescript/no-unsafe-declaration-merging": "error",
        "typescript/no-unsafe-function-type": "error",
        "typescript/no-wrapper-object-types": "error",
        "typescript/prefer-as-const": "error",
        "typescript/prefer-namespace-keyword": "error",
        "typescript/triple-slash-reference": "error",
        "react-hooks/rules-of-hooks": "error",
        "react-hooks/exhaustive-deps": "warn",
        "react/only-export-components": ["error", { allowConstantExport: true }],
      },
    },
    {
      files: ["packages/ui/src/**/*.ts", "packages/ui/src/**/*.tsx"],
      rules: {
        "openchamber/no-physical-sides": "error",
      },
    },
  ],
});
