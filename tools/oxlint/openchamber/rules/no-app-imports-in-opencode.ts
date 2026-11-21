import path from "node:path";

import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { isTestFile, toPosix } from "../shared/scope.ts";

const OPENCODE_FOLDER = "/packages/web/server/lib/opencode/";
const SERVER_ROOT = "/packages/web/server/";
const SERVER_SPECIFIER = /^@openchamber\/web\/server\//;
const APP_FOLDER = /\/packages\/web\/server\/lib\/(settings|appearance|server-frame|self-update|snippets)\//;

const ALLOWED_EDGES = [
  {
    from: "lib/opencode/routes.js",
    to: "lib/settings/settings-files.js",
    reason: "routes.js still registers GET and PUT /api/config/settings; the settings runtime arrives injected, and only the request's settings surface is parsed by the settings module's own reader.",
  },
] as const;

function resolveTarget(filename: string, specifier: string): string | null {
  if (SERVER_SPECIFIER.test(specifier)) {
    const posix = toPosix(filename);
    const root = posix.slice(0, posix.indexOf(SERVER_ROOT) + SERVER_ROOT.length);
    return `${root}${specifier.replace(SERVER_SPECIFIER, "")}`;
  }
  if (!specifier.startsWith(".")) return null;
  return toPosix(path.resolve(path.dirname(filename), specifier));
}

const withoutExtension = (file: string) => file.replace(/\.[cm]?[jt]s$/, "");

function isAllowedEdge(filename: string, target: string): boolean {
  const from = withoutExtension(toPosix(filename));
  const to = withoutExtension(target);
  return ALLOWED_EDGES.some((edge) => from.endsWith(`${SERVER_ROOT}${withoutExtension(edge.from)}`) && to.endsWith(`${SERVER_ROOT}${withoutExtension(edge.to)}`));
}

export const noAppImportsInOpencodeRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Keep OpenChamber's own server features out of lib/opencode's imports.",
    },
    messages: {
      appImport:
        "packages/web/server/lib/opencode holds OpenCode's own concerns and does not import from lib/settings, lib/appearance, lib/server-frame, lib/self-update or lib/snippets. Pass what it needs in as a dependency from the caller, or move the importing code to the folder that owns the feature. A deliberate edge goes into ALLOWED_EDGES in tools/oxlint/openchamber/rules/no-app-imports-in-opencode.ts with its reason.",
    },
  },
  createOnce(context) {
    const check = (source: ESTree.Node | null | undefined) => {
      if (!source || source.type !== "Literal" || typeof source.value !== "string") return;
      if (!toPosix(context.filename).includes(OPENCODE_FOLDER) || isTestFile(context.filename)) return;
      const target = resolveTarget(context.filename, source.value);
      if (!target || !APP_FOLDER.test(`${target}/`)) return;
      if (isAllowedEdge(context.filename, target)) return;
      context.report({ node: source, messageId: "appImport" });
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
