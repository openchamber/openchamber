// The setup commands a worktree runs when the server makes it on its own
// (an agent's `session.create` or `session.moveToWorktree`), with no client
// there to show the trust prompt. The New worktree dialog
// resolves the same commands in the client (`resolveWorktreeSetupCommands` in
// `packages/ui/src/lib/sharedTrustConfirmation.ts`) and sends them as the
// creation's `startCommand`; this module gives the server the same answer.

/** `$ROOT_PROJECT_PATH` and its older name `$ROOT_WORKTREE_PATH`, with or without braces. */
const substituteProjectPath = (command, projectPath) => command
  .replace(/\$\{?ROOT_PROJECT_PATH\}?/g, projectPath)
  .replace(/\$\{?ROOT_WORKTREE_PATH\}?/g, projectPath);

/**
 * The merged setup view (`mergeProjectSetup`) as one `startCommand` for
 * `createWorktree`, in `projectPath`'s terms, joined with `&&` the way the
 * client joins them. Shared commands the user has not trusted are left out
 * and returned in `untrustedSkipped`, the answer the dialog gives when the
 * user skips them: running commands from a pull nobody looked at is what the
 * trust prompt exists to prevent, and a caller without a client cannot ask.
 *
 * `createCommand` is the user's own command that creates the worktree in
 * place of `git worktree add` (personal only, so nothing to trust), `''` for
 * the built-in creation.
 *
 * @param {{ setupWorktree: string[], trust: { trusted: boolean }, shared: { setupWorktree: string[] }, personal: { setupWorktree: string[], setupWorktreeMode: string, createWorktreeCommand?: string } }} setup
 * @param {string} projectPath
 * @returns {{ startCommand: string, createCommand: string, untrustedSkipped: string[] }}
 */
export const worktreeSetupOf = (setup, projectPath) => {
  const skipsShared = setup.shared.setupWorktree.length > 0
    && setup.personal.setupWorktreeMode !== 'replace'
    && !setup.trust.trusted;
  const commands = skipsShared ? setup.personal.setupWorktree : setup.setupWorktree;
  return {
    startCommand: commands.map((command) => substituteProjectPath(command, projectPath)).join(' && '),
    createCommand: setup.personal.createWorktreeCommand ?? '',
    untrustedSkipped: skipsShared ? setup.shared.setupWorktree : [],
  };
};
