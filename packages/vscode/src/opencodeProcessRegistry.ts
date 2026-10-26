/**
 * Managed OpenCode process registry + orphan reaper.
 *
 * Shared with packages/web/server/lib/opencode/managed-process-registry.js via
 * esbuild bundling. Keep this module as a thin re-export so web and VS Code
 * cannot diverge: a process spawned by any runtime (web, desktop, VS Code) must
 * be reapable by any other, which only holds while all runtimes read and write
 * the same on-disk registry with the same algorithm.
 *
 * Callers here pass `runtime: 'vscode'`; the shared module defaults to 'web'.
 */
export {
  registerManagedProcess,
  unregisterManagedProcess,
  reapOrphanedProcesses,
} from '../../web/server/lib/opencode/managed-process-registry.js';
