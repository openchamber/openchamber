import type { ESTree } from "@oxlint/plugins";

const GLOBAL_OBJECTS = new Set(["window", "globalThis", "self"]);

export function globalCallName(node: ESTree.CallExpression): string | null {
  const callee = node.callee;
  if (callee.type === "Identifier") return callee.name;
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    GLOBAL_OBJECTS.has(callee.object.name) &&
    callee.property.type === "Identifier"
  ) {
    return callee.property.name;
  }
  return null;
}
