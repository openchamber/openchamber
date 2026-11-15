import path from "node:path";

import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { isUiSource, toPosix } from "../shared/scope.ts";

const RUNTIME_PACKAGE = /\/packages\/(web|electron|vscode|mobile)\//;
const RUNTIME_SPECIFIER = /^@openchamber\/(web|electron|vscode|mobile)(\/|$)/;

function reachesRuntimePackage(filename: string, specifier: string): boolean {
  if (RUNTIME_SPECIFIER.test(specifier)) return true;
  if (!specifier.startsWith(".")) return false;
  return RUNTIME_PACKAGE.test(`${toPosix(path.resolve(path.dirname(filename), specifier))}/`);
}

export const noCrossRuntimeImportsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow shared UI code importing from a runtime package, types included.",
    },
    messages: {
      crossRuntime:
        "Shared UI runs in every runtime (web, desktop, VS Code, mobile) and cannot import from one of them, types included. Reach a runtime capability through RuntimeAPIs or runtimeFetch, and put a type both sides need in packages/ui or packages/sdk. See the ui-api-decoupling skill.",
    },
  },
  createOnce(context) {
    const check = (source: ESTree.Node | null | undefined) => {
      if (!source || source.type !== "Literal" || typeof source.value !== "string") return;
      if (!isUiSource(context.filename)) return;
      if (reachesRuntimePackage(context.filename, source.value)) {
        context.report({ node: source, messageId: "crossRuntime" });
      }
    };
    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      TSImportType: (node) => check(node.source),
    };
  },
});
