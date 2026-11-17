import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { isUiSource, isUnder } from "../shared/scope.ts";

const WIRE_CLIENT = /^@opencode\/client(\/|$)/;
const OWNERS = ["/packages/ui/src/lib/opencode/"];

export const noWireClientImportsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Keep the OpenCode client and its wire types inside lib/opencode.",
    },
    messages: {
      wireClient:
        "Only packages/ui/src/lib/opencode imports @opencode/client. Use the domain model and opencodeClient from lib/opencode here, and add what is missing there, so a change in the OpenCode API is fixed in one folder. See the ui-api-decoupling skill.",
    },
  },
  createOnce(context) {
    const check = (source: ESTree.Node | null | undefined) => {
      if (!source || source.type !== "Literal" || typeof source.value !== "string") return;
      if (!WIRE_CLIENT.test(source.value)) return;
      if (!isUiSource(context.filename) || isUnder(context.filename, OWNERS)) return;
      context.report({ node: source, messageId: "wireClient" });
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
