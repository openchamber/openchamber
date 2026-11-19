import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

export const serverJsSpecifiersRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Require emitted runtime extensions in server TypeScript imports." },
    messages: {
      emittedExtension: "Server TypeScript keeps .js import specifiers so emitted code runs under Node. Use .js for code, including type imports; keep .json, .cjs or .mjs only for an existing runtime asset.",
    },
  },
  createOnce(context) {
    const check = (source: ESTree.Node | null | undefined) => {
      if (!source || source.type !== "Literal" || typeof source.value !== "string") return;
      if (source.value.startsWith(".") && !/\.(?:js|json|cjs|mjs)$/.test(source.value)) {
        context.report({ node: source, messageId: "emittedExtension" });
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
