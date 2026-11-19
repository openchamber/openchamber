import type { WorktreeSetup, WorktreeSetupInput } from './contracts.js';

const substituteProjectPath = (command: string, projectPath: string) => command
  .replace(/\$\{?ROOT_PROJECT_PATH\}?/g, projectPath)
  .replace(/\$\{?ROOT_WORKTREE_PATH\}?/g, projectPath);

export const worktreeSetupOf = (setup: WorktreeSetupInput, projectPath: string): WorktreeSetup => {
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
