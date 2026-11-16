import { defineRule } from "@oxlint/plugins";

import { globalCallName } from "../shared/global-call.ts";
import { isUiSource, isUnder } from "../shared/scope.ts";

const OWNERS = ["/packages/ui/src/lib/runtime-fetch.ts", "/packages/ui/src/lib/runtime-auth.ts"];

export const noRawFetchRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow bare fetch() in shared UI; requests go through the runtime transport.",
    },
    messages: {
      rawFetch:
        "A bare fetch() skips the runtime's base URL and auth, so it works on web and breaks on desktop, VS Code or mobile. Call an OpenChamber route with runtimeFetch('/api/...') and an OpenCode endpoint through opencodeClient. See the ui-api-decoupling skill.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (globalCallName(node) !== "fetch") return;
        if (!isUiSource(context.filename) || isUnder(context.filename, OWNERS)) return;
        context.report({ node: node.callee, messageId: "rawFetch" });
      },
    };
  },
});
