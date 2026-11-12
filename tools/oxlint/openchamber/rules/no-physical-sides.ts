import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

// A physical horizontal Tailwind class (`ml-`, `pr-`, `left-`, `text-right`,
// `rounded-l`, `border-r`...) inside a class list. `left-1/2` stays allowed: it
// centres together with `-translate-x-1/2`, which only works physically.
const PHYSICAL_CLASS = new RegExp(
  "(^|[\\s:!])-?(m[lr]|p[lr]|left|right|scroll-[mp][lr])-(?!1/2)(\\d|\\[|\\(|(auto|px|full)(?=$|[\\s!]))" +
    "|(^|[\\s:!])text-(left|right)(?=$|[\\s!])" +
    "|(^|[\\s:!])(rounded-(l|r|tl|tr|bl|br)|border-(l|r))(?=$|[\\s!-])",
);

const CLASS_ATTRIBUTE = /[Cc]lass[Nn]ame$/;
const CLASS_FUNCTION = /^(cn|clsx|cva)$/;
const CLASS_VARIABLE = /[Cc]lass|CLASS/;
const CLASS_KEY = /[Cc]lass/;

/** Where class lists live: className props, cn()/clsx()/cva() calls, and variables or object keys named after classes. */
function isClassContext(node: ESTree.Node): boolean {
  switch (node.type) {
    case "JSXAttribute":
      return node.name.type === "JSXIdentifier" && CLASS_ATTRIBUTE.test(node.name.name);
    case "CallExpression":
      return node.callee.type === "Identifier" && CLASS_FUNCTION.test(node.callee.name);
    case "VariableDeclarator":
      return node.id.type === "Identifier" && CLASS_VARIABLE.test(node.id.name);
    case "Property":
      return node.key.type === "Identifier" && CLASS_KEY.test(node.key.name);
    default:
      return false;
  }
}

function insideClassList(node: ESTree.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (isClassContext(current)) return true;
  }
  return false;
}

/** Flag physical horizontal classes in class lists, so the layout mirrors in right-to-left locales. */
export const noPhysicalSidesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow physical horizontal Tailwind classes in class lists; use logical sides.",
    },
    messages: {
      physicalSide:
        "Use logical sides (ms/me, ps/pe, inset-s/inset-e, text-start/end, rounded-s/e, border-s/e) so the layout mirrors in Arabic and Hebrew. A side that is physical on purpose takes an oxlint-disable-next-line comment saying why; see the rtl-layout skill.",
    },
  },
  createOnce(context) {
    return {
      Literal(node) {
        if (typeof node.value !== "string" || !PHYSICAL_CLASS.test(node.value)) return;
        if (insideClassList(node)) context.report({ node, messageId: "physicalSide" });
      },
      TemplateElement(node) {
        if (!PHYSICAL_CLASS.test(node.value.raw)) return;
        if (insideClassList(node)) context.report({ node, messageId: "physicalSide" });
      },
    };
  },
});
