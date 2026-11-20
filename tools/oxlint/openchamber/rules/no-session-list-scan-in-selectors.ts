import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const SESSION_LISTS = new Set(["activeSessions", "archivedSessions"]);
const SCANS = new Set(["filter", "find", "findLast", "findIndex", "some", "every", "map", "flatMap", "reduce", "forEach"]);

function propertyName(node: ESTree.Node): string | null {
  if (node.type !== "MemberExpression" || node.computed || node.property.type !== "Identifier") return null;
  return node.property.name;
}

function insideGlobalSessionsSelector(node: ESTree.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === "CallExpression" && current.callee.type === "Identifier" && current.callee.name === "useGlobalSessionsStore") return true;
  }
  return false;
}

/** Flag a scan of the whole session list inside a useGlobalSessionsStore selector, by method or by loop. */
export const noSessionListScanInSelectorsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow scanning activeSessions or archivedSessions inside a useGlobalSessionsStore selector.",
    },
    messages: {
      scan:
        "The global sessions store calls set() on every streamed step of any session (noteDeferredSessionUpdate), and every selector runs each time, so a scan of the whole list runs that often in every subscriber. Read the indexes the store keeps (entityById, structure.activeChildrenByParentId, structure.activeIdsByDirectory), or select the list and derive from it in useMemo.",
    },
  },
  createOnce(context) {
    return {
      MemberExpression(node) {
        if (!SCANS.has(propertyName(node) ?? "")) return;
        if (!SESSION_LISTS.has(propertyName(node.object) ?? "")) return;
        if (insideGlobalSessionsSelector(node)) context.report({ node, messageId: "scan" });
      },
      ForOfStatement(node) {
        if (!SESSION_LISTS.has(propertyName(node.right) ?? "")) return;
        if (insideGlobalSessionsSelector(node)) context.report({ node: node.right, messageId: "scan" });
      },
    };
  },
});
