import { defineRule } from "@oxlint/plugins";

import { globalCallName } from "../shared/global-call.ts";
import { isUiSource, isUnder } from "../shared/scope.ts";

const TIMERS = new Set(["setTimeout", "setInterval", "requestAnimationFrame", "requestIdleCallback"]);
const OWNERS = ["/packages/ui/src/lib/timing/", "/packages/ui/src/hooks/useDebouncedValue.ts"];

export const noTimersRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow new imperative timers in shared UI outside the timing helpers.",
    },
    messages: {
      timer:
        "A timer in UI code usually hides an ordering problem: something runs before the state it needs exists. Find what runs too early and fix that. When the delay is the feature (a debounce, a frame-aligned measurement), use useDebouncedValue or a helper in packages/ui/src/lib/timing, adding one there if none fits. When neither applies, stop and report what you found; do not add the timer.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const name = globalCallName(node);
        if (name === null || !TIMERS.has(name)) return;
        if (!isUiSource(context.filename) || isUnder(context.filename, OWNERS)) return;
        context.report({ node: node.callee, messageId: "timer" });
      },
    };
  },
});
