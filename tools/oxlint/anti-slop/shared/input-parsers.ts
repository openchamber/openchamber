import type { ESTree } from "@oxlint/plugins";

export type RuntimeFunction = ESTree.ArrowFunctionExpression | ESTree.FunctionDeclaration | ESTree.FunctionExpression;

export function isRuntimeFunction(node: ESTree.Node): node is RuntimeFunction {
  return node.type === "ArrowFunctionExpression" || node.type === "FunctionDeclaration" || node.type === "FunctionExpression";
}

export function isExportedInputParser(node: RuntimeFunction, filename: string, patterns: readonly string[]): boolean {
  if (!patterns.some((pattern) => new RegExp(pattern, "u").test(filename.replaceAll("\\", "/")))) return false;
  const parameter = node.params[0];
  if (node.params.length !== 1 || parameter?.type !== "Identifier"
    || parameter.typeAnnotation?.typeAnnotation.type !== "TSUnknownKeyword") return false;
  const result = node.returnType?.typeAnnotation;
  if (result?.type !== "TSUnionType" || !result.types.some((part) => part.type === "TSNullKeyword")
    || result.types.some((part) => part.type === "TSUnknownKeyword" || part.type === "TSAnyKeyword")) return false;
  if (node.parent.type === "ExportNamedDeclaration" || node.parent.type === "ExportDefaultDeclaration") return true;
  return node.parent.type === "VariableDeclarator"
    && node.parent.parent.type === "VariableDeclaration"
    && node.parent.parent.parent.type === "ExportNamedDeclaration";
}
