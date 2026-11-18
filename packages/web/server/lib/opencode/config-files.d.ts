export function readWorktreeDirectorySetting(
  workingDirectory: string,
  primaryWorktree?: string,
): string | null;

export const OPENCODE_CONFIG_DIR: string;
export function getOpenCodeDataDir(env?: NodeJS.ProcessEnv): string;

export function getAncestors(startDir: string | null | undefined, stopDir?: string | null): string[];
export function findWorktreeRoot(startDir: string | null | undefined): string | null;
