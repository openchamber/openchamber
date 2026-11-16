import { defineRule } from "@oxlint/plugins";

import { globalCallName } from "../shared/global-call.ts";
import { isTestFile } from "../shared/scope.ts";

const WAITS = new Set(["setTimeout", "setInterval"]);

export const noRealWaitsInTestsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow real timers in tests.",
    },
    messages: {
      realWait:
        "A test that waits on a real timer guesses how long the code takes, and fails on a busy machine. Await the promise or event the code produces, or inject the clock and advance it. A wait of 0 to let things settle is the same guess.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const name = globalCallName(node);
        if (name === null || !WAITS.has(name) || !isTestFile(context.filename)) return;
        context.report({ node: node.callee, messageId: "realWait" });
      },
    };
  },
});
