import React from 'react';
import { execCommand } from '@/lib/execCommands';
import type { WorktreeMetadata } from '@/types/worktree';

const normalizePath = (value: string): string => {
  if (!value) return '';
  const replaced = value.replace(/\\/g, '/');
  if (replaced === '/') return '/';
  return replaced.replace(/\/+$/, '');
};

/**
 * Derive the primary worktree (project) root from the absolute git directory.
 *
 * For a secondary worktree the absolute git dir looks like:
 *   /home/user/project/.git/worktrees/<name>
 * → project root = /home/user/project
 *
 * For the primary worktree:
 *   /home/user/project/.git
 * → project root = /home/user/project  (same as currentDir, so NOT a secondary worktree)
 */
const deriveProjectRoot = (gitDir: string): string | null => {
  const normalized = normalizePath(gitDir);
  if (!normalized) return null;

  const worktreesMarker = '/.git/worktrees/';
  const markerIndex = normalized.indexOf(worktreesMarker);
  if (markerIndex > 0) {
    return normalized.slice(0, markerIndex) || null;
  }

  return null;
};

type DetectedResult = {
  projectDirectory: string;
  branch: string;
};

/**
 * Detect whether `directory` is a secondary git worktree by inspecting the
 * git directory structure.  Returns the project root and current branch when
 * detection succeeds, or `null` when the directory is not a secondary worktree.
 *
 * This is intentionally cheap – a single `git rev-parse` call.
 */
async function detectWorktreeRoot(directory: string): Promise<DetectedResult | null> {
  const result = await execCommand(
    'git rev-parse --absolute-git-dir --abbrev-ref HEAD',
    directory,
  );
  if (!result.success) return null;

  const lines = (result.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;

  const gitDir = normalizePath(lines[0]);
  const branch = lines[1] || '';

  const projectRoot = deriveProjectRoot(gitDir);
  if (!projectRoot) return null;

  // Verify it's actually a different directory (secondary worktree, not main)
  const normalizedDir = normalizePath(directory);
  if (projectRoot === normalizedDir) return null;

  return { projectDirectory: projectRoot, branch };
}

/**
 * When the store-based `WorktreeMetadata` lookup fails, this hook falls back to
 * a lightweight git probe (`git rev-parse --absolute-git-dir`) to detect whether
 * `currentDirectory` is a secondary worktree.  If it is, a minimal
 * `WorktreeMetadata` object is synthesised so that features like
 * "Re-integrate commits" can function without explicit store entries.
 *
 * @param currentDirectory  The effective directory for the active session/tab.
 * @param storeMetadata     The result of the normal store-based lookup (may be
 *                          `undefined`).
 * @returns The store metadata when available, otherwise the detected metadata,
 *          otherwise `undefined`.
 */
export function useDetectedWorktreeMetadata(
  currentDirectory: string | undefined,
  storeMetadata: WorktreeMetadata | undefined,
): WorktreeMetadata | undefined {
  const [detected, setDetected] = React.useState<WorktreeMetadata | undefined>();
  const lastDirRef = React.useRef<string | undefined>();

  React.useEffect(() => {
    // Store-based lookup succeeded – no detection needed.
    if (storeMetadata) {
      if (detected) setDetected(undefined);
      return;
    }

    if (!currentDirectory) {
      if (detected) setDetected(undefined);
      return;
    }

    // If the directory hasn't changed and we already ran detection, skip.
    if (currentDirectory === lastDirRef.current) return;
    lastDirRef.current = currentDirectory;

    let cancelled = false;
    void (async () => {
      const result = await detectWorktreeRoot(currentDirectory);
      if (cancelled) return;

      if (!result) {
        setDetected(undefined);
        return;
      }

      const normalizedPath = normalizePath(currentDirectory);
      const name = normalizedPath.split('/').filter(Boolean).pop() || normalizedPath;

      setDetected({
        source: 'sdk',
        path: normalizedPath,
        projectDirectory: result.projectDirectory,
        branch: result.branch,
        label: result.branch || name,
        name,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [currentDirectory, storeMetadata, detected]);

  return storeMetadata ?? detected;
}
