import { getGitStatus } from '@/lib/gitApi';
import { execCommand } from '@/lib/execCommands';
import { normalizePath } from '@/lib/pathUtils';
import type { WorktreeMetadata } from '@/types/worktree';

const toAbsolutePath = (baseDir: string, maybeRelativePath: string): string => {
  const normalizedBase = normalizePath(baseDir) ?? '';
  const normalizedInput = normalizePath(maybeRelativePath) ?? '';
  if (!normalizedInput) return normalizedBase;
  if (normalizedInput.startsWith('/')) return normalizedInput;

  const stack = normalizedBase.split('/').filter(Boolean);
  const parts = normalizedInput.split('/').filter(Boolean);
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return `/${stack.join('/')}`;
};

const derivePrimaryWorktreeRootFromGitDir = (gitDir: string): string | null => {
  const normalized = normalizePath(gitDir);
  if (!normalized) return null;
  if (normalized.endsWith('/.git')) {
    return normalized.slice(0, -'/.git'.length) || null;
  }
  const worktreesMarker = '/.git/worktrees/';
  const markerIndex = normalized.indexOf(worktreesMarker);
  if (markerIndex > 0) {
    return normalized.slice(0, markerIndex) || null;
  }
  return null;
};

export async function getWorktreeStatus(worktreePath: string): Promise<WorktreeMetadata['status']> {
  const normalizedPath = normalizePath(worktreePath) ?? '';
  const status = await getGitStatus(normalizedPath);
  return {
    isDirty: !status.isClean,
    ahead: status.ahead,
    behind: status.behind,
    upstream: status.tracking,
  };
}

export async function getRootBranch(projectDirectory: string): Promise<string> {
  const normalizedPath = normalizePath(projectDirectory) ?? '';
  if (!normalizedPath) {
    return 'HEAD';
  }

  const resolveProjectRoot = async (directory: string): Promise<string> => {
    const absoluteGitDirResult = await execCommand('git rev-parse --absolute-git-dir', directory);
    const absoluteGitDir = normalizePath((absoluteGitDirResult.stdout || '').trim());
    if (absoluteGitDirResult.success && absoluteGitDir) {
      const rootFromAbsoluteGitDir = derivePrimaryWorktreeRootFromGitDir(absoluteGitDir);
      if (rootFromAbsoluteGitDir) {
        return rootFromAbsoluteGitDir;
      }
    }

    const commonDirResult = await execCommand('git rev-parse --git-common-dir', directory);
    const rawCommonDir = normalizePath((commonDirResult.stdout || '').trim());
    if (!commonDirResult.success || !rawCommonDir) return directory;

    const commonDir = toAbsolutePath(directory, rawCommonDir);
    const rootFromCommonDir = derivePrimaryWorktreeRootFromGitDir(commonDir);
    if (rootFromCommonDir) {
      return rootFromCommonDir;
    }

    return directory;
  };

  try {
    const projectRoot = await resolveProjectRoot(normalizedPath).catch(() => normalizedPath);
    const status = await getGitStatus(projectRoot);
    const branch = typeof status.current === 'string' ? status.current.trim() : '';
    return branch || 'HEAD';
  } catch {
    return 'HEAD';
  }
}
