import { isBuiltin } from "node:module";

import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import { toPosix } from "../shared/scope.ts";

export const gatekeeperStandardLibraryRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Keep the standalone gatekeeper runnable with only Node installed." },
    messages: {
      dependency: "The gatekeeper is copied into its container as one script without node_modules or sibling files. Use a literal Node standard-library import so it can run there.",
    },
  },
  createOnce(context) {
    const check = (source: ESTree.Node) => {
      if (!toPosix(context.filename).endsWith("/packages/web/server/lib/spaces/gatekeeper-program.cjs")) return;
      if (source.type === "Literal" && typeof source.value === "string" && isBuiltin(source.value)) return;
      context.report({ node: source, messageId: "dependency" });
    };
    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => { if (node.source) check(node.source); },
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      CallExpression: (node) => {
        if (node.callee.type === "Identifier" && node.callee.name === "require" && node.arguments[0]) check(node.arguments[0]);
      },
    };
  },
});
