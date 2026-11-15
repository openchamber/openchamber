import { eslintCompatPlugin } from "@oxlint/plugins";

import { noCommentsRule } from "./rules/no-comments.ts";
import { noCrossRuntimeImportsRule } from "./rules/no-cross-runtime-imports.ts";
import { noEffectsInComponentsRule } from "./rules/no-effects-in-components.ts";
import { noPhysicalSidesRule } from "./rules/no-physical-sides.ts";
import { noRawFetchRule } from "./rules/no-raw-fetch.ts";
import { noTimersRule } from "./rules/no-timers.ts";
import { noWireClientImportsRule } from "./rules/no-wire-client-imports.ts";

/**
 * OpenChamber's own lint rules. `oxlint.config.ts` runs the ones the code
 * already satisfies and fails on any finding; `oxlint.anti-slop.config.ts`
 * runs the ones with a backlog, as a ratchet over changed files.
 */
const openchamberPlugin = eslintCompatPlugin({
  meta: { name: "openchamber" },
  rules: {
    "no-comments": noCommentsRule,
    "no-cross-runtime-imports": noCrossRuntimeImportsRule,
    "no-effects-in-components": noEffectsInComponentsRule,
    "no-physical-sides": noPhysicalSidesRule,
    "no-raw-fetch": noRawFetchRule,
    "no-timers": noTimersRule,
    "no-wire-client-imports": noWireClientImportsRule,
  },
});

export default openchamberPlugin;
