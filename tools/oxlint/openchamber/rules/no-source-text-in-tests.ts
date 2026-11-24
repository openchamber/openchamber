import { defineRule } from "@oxlint/plugins";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

import { isTestFile } from "../shared/scope.ts";

const READERS = new Set(["readFileSync", "readFile"]);
const WRITERS = new Set(["writeFileSync", "writeFile", "appendFileSync", "appendFile"]);
const EXECUTORS = new Set(["runInNewContext", "runInContext", "runInThisContext", "compileFunction"]);
const SOURCE_PATH = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function callName(node: ESTree.CallExpression | ESTree.NewExpression): string | null {
  const callee = node.callee;
  if (callee.type === "Identifier") return callee.name;
  return callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier"
    ? callee.property.name
    : null;
}

function resolveVariable(sourceCode: SourceCode, identifier: Extract<ESTree.Node, { type: "Identifier" }>): Variable | null {
  let scope: Scope | null = sourceCode.getScope(identifier);
  while (scope) {
    const variable = scope.set.get(identifier.name);
    if (variable) return variable;
    scope = scope.upper;
  }
  return null;
}

function nodeCallName(sourceCode: SourceCode, node: ESTree.CallExpression, modules: readonly string[]): string | null {
  const callee = node.callee;
  const receiver = callee.type === "MemberExpression" ? callee.object : null;
  const promises = receiver?.type === "MemberExpression" && !receiver.computed &&
    receiver.property.type === "Identifier" && receiver.property.name === "promises";
  const identifier = callee.type === "Identifier" ? callee :
    callee.type === "MemberExpression" && !callee.computed && receiver?.type === "Identifier" ? receiver :
      promises && receiver.object.type === "Identifier" ? receiver.object : null;
  if (!identifier) return null;
  const definition = resolveVariable(sourceCode, identifier)?.defs[0];
  if (definition?.type !== "ImportBinding") return null;
  const specifier = definition.node;
  if (specifier.parent?.type !== "ImportDeclaration" ||
    !modules.includes(String(specifier.parent.source.value).replace(/^node:/, ""))) return null;
  if (promises && !["node:fs", "fs"].includes(String(specifier.parent.source.value))) return null;
  if (callee.type === "Identifier" && specifier.type === "ImportSpecifier") {
    return specifier.imported.type === "Identifier" ? specifier.imported.name : String(specifier.imported.value);
  }
  return callee.type === "MemberExpression" && specifier.type !== "ImportSpecifier" ? callName(node) : null;
}

function staticPath(
  node: ESTree.Node,
  sourceCode: SourceCode,
  filename: string,
  cwd: string,
  visited = new Set<Variable>(),
): string | null {
  switch (node.type) {
    case "Literal":
      return typeof node.value === "string" ? node.value : null;
    case "TemplateLiteral":
      return node.expressions.length === 0 ? node.quasis[0].value.cooked : null;
    case "Identifier": {
      const variable = resolveVariable(sourceCode, node);
      if (!variable || visited.has(variable) || variable.references.some((reference) => reference.isWrite() && !reference.init)) return null;
      const definition = variable.defs[0];
      if (definition?.type !== "Variable" || definition.node.type !== "VariableDeclarator" ||
        definition.node.id.type !== "Identifier" || !definition.node.init) return null;
      return staticPath(definition.node.init, sourceCode, filename, cwd, new Set(visited).add(variable));
    }
    case "MemberExpression":
      return !node.computed && node.property.type === "Identifier" && node.property.name === "url" &&
        node.object.type === "MetaProperty" && node.object.meta.name === "import"
        ? filename
        : null;
    case "CallExpression":
    case "NewExpression": {
      const name = node.type === "NewExpression"
        ? node.callee.type === "Identifier" && node.callee.name === "URL" &&
          !resolveVariable(sourceCode, node.callee)?.defs.length ? "URL" : null
        : nodeCallName(sourceCode, node, ["path", "url"]);
      if (node.type === "CallExpression" && callName(node) === "cwd" && node.callee.type === "MemberExpression" &&
        node.callee.object.type === "Identifier" && node.callee.object.name === "process" &&
        !resolveVariable(sourceCode, node.callee.object)?.defs.length) return cwd;
      if (!["URL", "fileURLToPath", "dirname", "join", "resolve"].includes(name ?? "")) return null;
      const args = node.arguments.map((argument) => staticPath(argument, sourceCode, filename, cwd, visited));
      if (args.some((argument) => argument === null)) return null;
      const values = args.filter((argument) => argument !== null);
      if (name === "URL" && node.type === "NewExpression" && values.length === 2) {
        try {
          return fileURLToPath(new URL(values[0], pathToFileURL(values[1])));
        } catch {
          return null;
        }
      }
      if (name === "fileURLToPath" && values.length === 1) {
        if (path.isAbsolute(values[0])) return values[0];
        try {
          return fileURLToPath(values[0]);
        } catch {
          return null;
        }
      }
      if (name === "dirname" && values.length === 1) return path.dirname(values[0]);
      if (name === "join" && values.length > 0) return path.join(...values);
      if (name === "resolve") return path.resolve(cwd, ...values);
      return null;
    }
    default:
      return null;
  }
}

export const noSourceTextInTestsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow tests that read a source file as text.",
    },
    messages: {
      sourceText:
        "A test that reads a source file and searches its text checks spelling, so a rename fails it and a behavior bug passes. Import the code and assert what it returns or does. A rule about how code is written belongs in a lint rule under tools/oxlint/openchamber.",
    },
  },
  createOnce(context) {
    const reads: ESTree.CallExpression[] = [];
    const writes: ESTree.Node[] = [];
    return {
      Program() {
        reads.length = 0;
        writes.length = 0;
      },
      CallExpression(node) {
        if (!isTestFile(context.filename)) return;
        const name = nodeCallName(context.sourceCode, node, ["fs", "fs/promises"]);
        if (name !== null && READERS.has(name)) reads.push(node);
        if (name !== null && WRITERS.has(name) && node.arguments[0]) writes.push(node.arguments[0]);
      },
      "Program:exit"() {
        const filename = path.resolve(context.cwd, context.filename);
        const packageIndex = filename.replaceAll("\\", "/").indexOf("/packages/");
        const root = packageIndex < 0 ? context.cwd : filename.slice(0, packageIndex);
        const resolve = (node: ESTree.Node) => {
          const value = staticPath(node, context.sourceCode, filename, context.cwd);
          return value === null ? null : path.resolve(context.cwd, value);
        };
        const written = new Set(writes.map(resolve));
        for (const node of reads) {
          const value = node.parent?.type === "AwaitExpression" ? node.parent : node;
          const consumer = value.parent;
          if (consumer?.type === "CallExpression" && consumer.arguments[0] === value &&
            (EXECUTORS.has(nodeCallName(context.sourceCode, consumer, ["vm"]) ?? "") ||
              nodeCallName(context.sourceCode, consumer, ["module"]) === "stripTypeScriptTypes")) continue;
          const target = node.arguments[0] ? resolve(node.arguments[0]) : null;
          if (target === null || !SOURCE_PATH.test(target) || written.has(target) || isTestFile(target)) continue;
          const relative = path.relative(root, target);
          if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
            /(^|[/\\])(node_modules|dist|build|out|\.tmp)([/\\]|$)/.test(relative)) continue;
          context.report({ node: node.callee, messageId: "sourceText" });
        }
      },
    };
  },
});
