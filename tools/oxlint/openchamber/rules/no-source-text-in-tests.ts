import { defineRule } from "@oxlint/plugins";

import { isTestFile } from "../shared/scope.ts";

const READERS = new Set(["readFileSync", "readFile"]);
const SOURCE_PATH = /\.(tsx?|[cm]?jsx?|css)$/;

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
    return {
      CallExpression(node) {
        const callee = node.callee;
        const name =
          callee.type === "Identifier"
            ? callee.name
            : callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier"
              ? callee.property.name
              : null;
        if (name === null || !READERS.has(name) || !isTestFile(context.filename)) return;
        const text = context.sourceCode.getText(node);
        const literals = text.match(/(['"`])[^'"`\n]*\1/g) ?? [];
        if (literals.some((literal) => SOURCE_PATH.test(literal.slice(1, -1)))) {
          context.report({ node: callee, messageId: "sourceText" });
        }
      },
    };
  },
});
