import { defineRule } from "@oxlint/plugins";

import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

const VIRTUALIZER_HOOKS = new Set(["useVirtualizer", "useWindowVirtualizer"]);

function resolveVariable(sourceCode: SourceCode, identifier: Extract<ESTree.Node, { type: "Identifier" }>): Variable | null {
  let scope: Scope | null = sourceCode.getScope(identifier);
  while (scope) {
    const variable = scope.set.get(identifier.name);
    if (variable) return variable;
    scope = scope.upper;
  }
  return null;
}

function isVirtualizerCall(sourceCode: SourceCode, node: ESTree.CallExpression): boolean {
  const callee = node.callee;
  if (callee.type === "Identifier") {
    const variable = resolveVariable(sourceCode, callee);
    return variable?.defs.some((definition) => {
      if (definition.type !== "ImportBinding" || definition.node.type !== "ImportSpecifier") return false;
      const specifier = definition.node;
      const name = specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value;
      return specifier.parent.type === "ImportDeclaration" &&
        specifier.parent.source.value === "@tanstack/react-virtual" && VIRTUALIZER_HOOKS.has(String(name));
    }) ?? false;
  }
  if (
    callee.type !== "MemberExpression" ||
    callee.computed ||
    callee.object.type !== "Identifier" ||
    callee.property.type !== "Identifier" ||
    !VIRTUALIZER_HOOKS.has(callee.property.name)
  ) return false;
  return resolveVariable(sourceCode, callee.object)?.defs.some((definition) =>
    definition.type === "ImportBinding" &&
    definition.node.type === "ImportNamespaceSpecifier" &&
    definition.node.parent.type === "ImportDeclaration" &&
    definition.node.parent.source.value === "@tanstack/react-virtual"
  ) ?? false;
}

function propertyKey(node: ESTree.Node): string | null {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal") return String(node.value);
  return null;
}

function bindingValue(pattern: ESTree.Node, value: ESTree.Node, name: string): ESTree.Node | null {
  if (pattern.type === "Identifier") return pattern.name === name ? value : null;
  if (pattern.type === "AssignmentPattern") return bindingValue(pattern.left, value, name);
  if (pattern.type === "ObjectPattern" && value.type === "ObjectExpression") {
    for (const property of pattern.properties) {
      if (property.type !== "Property" || property.computed) continue;
      const key = propertyKey(property.key);
      const source = value.properties.find((item) =>
        item.type === "Property" && !item.computed && key !== null && propertyKey(item.key) === key
      );
      if (source?.type !== "Property") continue;
      const selected = bindingValue(property.value, source.value, name);
      if (selected) return selected;
    }
  }
  if (pattern.type === "ArrayPattern" && value.type === "ArrayExpression") {
    for (const [index, element] of pattern.elements.entries()) {
      const source = value.elements[index];
      if (!element || !source || source.type === "SpreadElement") continue;
      const selected = bindingValue(element, source, name);
      if (selected) return selected;
    }
  }
  return null;
}

function containsVirtualizer(
  sourceCode: SourceCode,
  node: ESTree.Node,
  visited = new Set<Variable>(),
  instanceIsReturned = true,
): boolean {
  switch (node.type) {
    case "CallExpression":
      return instanceIsReturned && isVirtualizerCall(sourceCode, node);
    case "Identifier": {
      const variable = resolveVariable(sourceCode, node);
      if (!variable || visited.has(variable)) return false;
      const nextVisited = new Set(visited).add(variable);
      return variable.defs.some((definition) => {
        if (definition.type !== "Variable" || definition.node.type !== "VariableDeclarator" || !definition.node.init) return false;
        const value = bindingValue(definition.node.id, definition.node.init, node.name);
        return value !== null && containsVirtualizer(sourceCode, value, nextVisited, instanceIsReturned);
      }) || variable.references.some((reference) =>
        reference.isWrite() &&
        !reference.init &&
        reference.identifier.parent.type === "AssignmentExpression" &&
        reference.identifier.parent.left === reference.identifier &&
        reference.writeExpr !== null &&
        containsVirtualizer(sourceCode, reference.writeExpr, nextVisited, instanceIsReturned)
      );
    }
    case "ObjectExpression":
      return node.properties.some((property) =>
        containsVirtualizer(sourceCode, property.type === "Property" ? property.value : property, visited)
      );
    case "ArrayExpression":
      return node.elements.some((element) => element !== null && containsVirtualizer(sourceCode, element, visited));
    case "SpreadElement":
      return containsVirtualizer(sourceCode, node.argument, visited, false);
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSTypeAssertion":
    case "TSNonNullExpression":
      return containsVirtualizer(sourceCode, node.expression, visited, instanceIsReturned);
    case "ConditionalExpression":
      return containsVirtualizer(sourceCode, node.consequent, visited, instanceIsReturned) ||
        containsVirtualizer(sourceCode, node.alternate, visited, instanceIsReturned);
    case "LogicalExpression":
      return containsVirtualizer(sourceCode, node.left, visited, instanceIsReturned) ||
        containsVirtualizer(sourceCode, node.right, visited, instanceIsReturned);
    case "SequenceExpression": {
      const last = node.expressions.at(-1);
      return last !== undefined && containsVirtualizer(sourceCode, last, visited, instanceIsReturned);
    }
    default:
      return false;
  }
}

type FunctionNode = ESTree.Function | ESTree.ArrowFunctionExpression;

function isHook(node: FunctionNode): boolean {
  if (node.type !== "ArrowFunctionExpression" && node.id?.name.startsWith("use")) return true;
  const parent = node.parent;
  if (parent.type === "VariableDeclarator" && parent.id.type === "Identifier") return parent.id.name.startsWith("use");
  if (parent.type === "Property" && !parent.computed && parent.key.type === "Identifier") return parent.key.name.startsWith("use");
  return false;
}

function enclosingFunction(node: ESTree.Node): FunctionNode | null {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === "FunctionDeclaration" || parent.type === "FunctionExpression" || parent.type === "ArrowFunctionExpression") return parent;
  }
  return null;
}

export const noVirtualizerReturnFromHooksRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow returning TanStack virtualizer instances from hooks.",
    },
    messages: {
      virtualizer:
        "The virtualizer's stable reference defeats re-rendering under React Compiler, which can memoize stale rows in the consuming component. Return getVirtualItems(), getTotalSize() and measure functions computed in the hook's body instead of the virtualizer object.",
    },
  },
  createOnce(context) {
    const check = (node: ESTree.Expression) => {
      if (containsVirtualizer(context.sourceCode, node)) context.report({ node, messageId: "virtualizer" });
    };
    return {
      ReturnStatement(node) {
        if (!node.argument) return;
        const owner = enclosingFunction(node);
        if (owner && isHook(owner)) check(node.argument);
      },
      ArrowFunctionExpression(node) {
        if (node.body.type !== "BlockStatement" && isHook(node)) check(node.body);
      },
    };
  },
});
