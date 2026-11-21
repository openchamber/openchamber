import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const ORIGIN_CHECKS = new Set(["isRequestOriginAllowed", "isPasswordlessSocketOriginAllowed"]);

const calleeName = (callee: ESTree.Node) => {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") return callee.property.name;
  return "";
};

const isTestOf = (node: ESTree.Node, parent: ESTree.Node) => {
  switch (parent.type) {
    case "IfStatement":
    case "WhileStatement":
    case "DoWhileStatement":
    case "ForStatement":
    case "ConditionalExpression":
      return parent.test === node;
    case "CallExpression":
      return parent.callee.type === "Identifier" && parent.callee.name === "Boolean" && parent.arguments[0] === node;
    default:
      return false;
  }
};

const decidesCondition = (node: ESTree.Node) => {
  let current: ESTree.Node = node;
  for (let parent = node.parent; parent; current = parent, parent = parent.parent) {
    if (parent.type === "UnaryExpression" && parent.operator === "!") return true;
    if (parent.type === "LogicalExpression") {
      if (parent.left === current && parent.operator !== "??") return true;
      continue;
    }
    return isTestOf(current, parent);
  }
  return false;
};

export const originCheckAwaitedRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Require an origin check to be awaited before it decides a condition." },
    messages: {
      unawaited:
        "Origin checks return a promise, and a promise is always truthy: `!check(req)` never rejects and `check(req) && ...` always passes. Await the check before using it as a condition.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (!ORIGIN_CHECKS.has(calleeName(node.callee))) return;
        if (decidesCondition(node)) {
          context.report({ node, messageId: "unawaited" });
          return;
        }
        const declarator = node.parent;
        if (declarator?.type !== "VariableDeclarator" || declarator.init !== node || declarator.id.type !== "Identifier") return;
        const stored = context.sourceCode.getDeclaredVariables(declarator).flatMap((variable) => variable.references);
        if (stored.some((reference) => reference.isRead() && decidesCondition(reference.identifier))) {
          context.report({ node, messageId: "unawaited" });
        }
      },
    };
  },
});
