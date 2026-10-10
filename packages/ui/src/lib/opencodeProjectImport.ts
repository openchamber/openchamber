import type { Project as OpenCodeProject } from '@/lib/opencode/model';
import { isChatDirectoryForHome } from '@/lib/chatDirectories';
import { normalizePath } from '@/lib/pathNormalization';
import { formatDirectoryName } from '@/lib/utils';

type OpenCodeProjectImportCandidate = {
  path: string;
  sandboxes: string[];
};

export const shouldAutoOpenOpenCodeProjectImportPrompt = (state: {
  runtime: 'supported' | 'vscode';
  projects: 'loading' | 'loaded';
  directories: 'checking' | 'checked';
  importableCount: number;
}): boolean => state.runtime === 'supported'
  && state.projects === 'loaded'
  && state.directories === 'checked'
  && state.importableCount > 0;

export const getOpenCodeProjectImportCandidates = (
  openCodeProjects: readonly OpenCodeProject[],
  configuredProjects: readonly { path: string }[],
  homeDirectory?: string | null,
): OpenCodeProjectImportCandidate[] => {
  const configuredPaths = new Set(
    configuredProjects
      .map((project) => normalizePath(project.path))
      .filter((path): path is string => path !== null),
  );
  const allSandboxPaths = new Set(
    openCodeProjects
      .flatMap((project) => project.sandboxes)
      .map((path) => normalizePath(path))
      .filter((path): path is string => path !== null),
  );
  const candidatesByPath = new Map<string, OpenCodeProjectImportCandidate>();

  for (const project of openCodeProjects) {
    const canonicalPath = normalizePath(project.worktree);
    if (
      !canonicalPath
      || canonicalPath === '/'
      || configuredPaths.has(canonicalPath)
      || allSandboxPaths.has(canonicalPath)
      || isChatDirectoryForHome(project.worktree, homeDirectory)
    ) continue;

    const existing = candidatesByPath.get(canonicalPath);
    const candidate = existing ?? {
      path: project.worktree,
      sandboxes: [],
    };
    const seenSandboxPaths = new Set(candidate.sandboxes.map((path) => normalizePath(path)));
    for (const sandbox of project.sandboxes) {
      const normalizedSandbox = normalizePath(sandbox);
      if (!normalizedSandbox || normalizedSandbox === canonicalPath || seenSandboxPaths.has(normalizedSandbox)) continue;
      candidate.sandboxes.push(sandbox);
      seenSandboxPaths.add(normalizedSandbox);
    }
    candidatesByPath.set(canonicalPath, candidate);
  }

  return [...candidatesByPath.values()];
};

export const excludeMissingOpenCodeProjectImportCandidates = <T extends { path: string }>(
  candidates: readonly T[],
  missingPaths: ReadonlySet<string>,
): T[] => candidates.filter((candidate) => !missingPaths.has(candidate.path));

export const getOpenCodeProjectImportDisplayName = (path: string, homeDirectory?: string | null): string => {
  const normalizedPath = normalizePath(path);
  return normalizedPath ? formatDirectoryName(normalizedPath, homeDirectory) || normalizedPath : path;
};
