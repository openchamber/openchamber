/**
 * Shared with packages/web/server/lib/injected-env.js via esbuild bundling.
 * Keep this module as a thin re-export so web and VS Code cannot diverge.
 */
export { assignInjectedEnv } from '../../web/server/lib/injected-env.js';
