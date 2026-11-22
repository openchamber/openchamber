import os from 'node:os';
import path from 'node:path';
import { isString } from '../shared/object-guards.js';

const isConfigObject = (value: unknown): value is { worktree?: unknown; directory?: unknown } => value !== null && typeof value === 'object';

export function resolveWorktreeDirectory<Config>(config: Config, primaryWorktree: string, homeDirectory = os.homedir()) {
  const worktree = isConfigObject(config) ? config.worktree : null;
  const directory = isConfigObject(worktree) ? worktree.directory : null;
  if (!isString(directory)) {
    return null;
  }

  const trimmed = directory.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === '~') {
    return path.resolve(homeDirectory);
  }
  if (/^~[\\/]/.test(trimmed)) {
    return path.resolve(homeDirectory, trimmed.slice(2));
  }
  return path.resolve(primaryWorktree, trimmed);
}
