import { defineRule } from "@oxlint/plugins";

import { isTestFile } from "../shared/scope.ts";

export const noModuleMocksInTestsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow replacing a module in a test with bun's mock.module().",
    },
    messages: {
      moduleMock:
        "A test that replaces a module checks how the code is wired, so it breaks on every refactor and stays green on a real bug. Pass the dependency in as an argument or prop and hand the test a small fake, or test the pure logic on its own. Behavior that needs the real modules together is proven by a scenario in the running app.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          callee.object.type !== "Identifier" ||
          callee.object.name !== "mock" ||
          callee.property.type !== "Identifier" ||
          callee.property.name !== "module"
        ) {
          return;
        }
        if (isTestFile(context.filename)) context.report({ node: callee, messageId: "moduleMock" });
      },
    };
  },
});
