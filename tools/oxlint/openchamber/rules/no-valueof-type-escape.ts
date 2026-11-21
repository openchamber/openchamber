import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

function memberPath(node: ESTree.Node): string {
  if (node.type === "Identifier") return node.name;
  if (node.type !== "MemberExpression") return "";
  const name = !node.computed && node.property.type === "Identifier"
    ? node.property.name
    : node.computed && node.property.type === "Literal" && typeof node.property.value === "string"
      ? node.property.value
      : "";
  return name ? `${memberPath(node.object)}.${name}` : "";
}

export const noValueofTypeEscapeRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Disallow Object.prototype.valueOf as a type escape." },
    messages: {
      typeEscape:
        "Object.prototype.valueOf.call/apply returns an unchecked type and cannot establish a field shape. Use a property-access predicate that preserves the input's primitive, inherited-property and nullish behavior.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const path = memberPath(node.callee);
        if (path === "Object.prototype.valueOf.call" || path === "Object.prototype.valueOf.apply") {
          context.report({ node, messageId: "typeEscape" });
        }
      },
    };
  },
});
