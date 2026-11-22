import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { isUiSource, isUnder } from "../shared/scope.ts";

const EFFECTS = new Set(["useEffect", "useLayoutEffect"]);
const PRODUCT_FOLDERS = ["/packages/ui/src/components/", "/packages/ui/src/apps/"];

function importedName(specifier: ESTree.ImportSpecifier): string {
  return specifier.imported.type === "Identifier" ? specifier.imported.name : String(specifier.imported.value);
}

export const noEffectsInComponentsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow new useEffect and useLayoutEffect in product components.",
    },
    messages: {
      effect:
        "Product components take no new effects. Compute the value during render, do the work in the event handler that causes it, or read external state through a store selector. Synchronizing with something outside React (a DOM API, a subscription, a socket) belongs in a named hook under packages/ui/src/hooks, reused where one exists.",
    },
  },
  createOnce(context) {
    const effectBindings = new Set<string>();
    const reactNamespaces = new Set<string>();

    const isEffect = (callee: ESTree.Expression | ESTree.Super): boolean => {
      if (callee.type === "Identifier") return effectBindings.has(callee.name);
      return (
        callee.type === "MemberExpression" &&
        !callee.computed &&
        callee.object.type === "Identifier" &&
        reactNamespaces.has(callee.object.name) &&
        callee.property.type === "Identifier" &&
        EFFECTS.has(callee.property.name)
      );
    };

    return {
      Program() {
        effectBindings.clear();
        reactNamespaces.clear();
      },
      ImportDeclaration(node) {
        if (node.source.value !== "react") return;
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") reactNamespaces.add(specifier.local.name);
          else if (EFFECTS.has(importedName(specifier))) effectBindings.add(specifier.local.name);
        }
      },
      CallExpression(node) {
        if (!isEffect(node.callee)) return;
        if (!isUiSource(context.filename) || !isUnder(context.filename, PRODUCT_FOLDERS)) return;
        context.report({ node: node.callee, messageId: "effect" });
      },
    };
  },
});
