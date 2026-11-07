import type { Session } from '@/lib/opencode/model';
import type { ConversationMetadata } from '@/lib/search/conversationSearch';
import type { OmniFilters, OmniQuery } from '@/lib/search/omniQuery';
import type { ConversationResult } from '@/hooks/useConversationSearch';
import type { WorktreeMetadata } from '@/types/worktree';
import type { DirectoryOwner } from './sessions/sessionOwnership';
import type { GroupSearchData, SessionGroup, SessionNode } from './types';
import { normalizePath } from './utils';

export const isSidebarSearchActive = (query: OmniQuery): boolean => query.text.trim().length > 0 || Object.keys(query.filters).length > 0;

type SidebarSearchProjection = { results: readonly ConversationResult[]; totalCount: number | null };

/** A filter-only search lists the admitted metadata without requiring a text match. */
export function projectSidebarSearchResults({ metadata, results, text, totalCount }: {
  metadata: readonly ConversationMetadata[]; results: readonly ConversationResult[]; text: string; totalCount: number | null;
}): SidebarSearchProjection {
  if (text.trim()) return { results, totalCount };
  return { results: metadata.map<ConversationResult>((item) => ({ sessionId: item.sessionId, title: item.title, titleRanges: [], directory: item.directory, archived: item.archived,
    metadata: { sessionId: item.sessionId, score: 0, titleRanges: [], matchedField: 'title' }, excerpt: null, moreMatches: 0 })), totalCount: metadata.length };
}

type SearchProject = { id: string; label?: string; normalizedPath: string };
type ScopeInput = {
  filters: OmniFilters;
  activeProjectId: string | null;
  projects: readonly SearchProject[];
  worktrees: ReadonlyMap<string, WorktreeMetadata[]>;
  knownDirectories: ReadonlySet<string>;
  owners: ReadonlyMap<string, DirectoryOwner>;
  sessions: readonly Session[];
  isVSCode: boolean;
};

/** Exact directory scope shared by metadata admission and the content request. */
export function resolveSidebarSearchScope(input: ScopeInput) {
  const { filters, projects, worktrees, knownDirectories, owners, sessions, isVSCode } = input;
  const matches = (value: string, labels: (string | undefined)[]) => labels.some((label) => label && (label.toLowerCase() === value.toLowerCase()
    || normalizePath(label)?.toLowerCase() === normalizePath(value)?.toLowerCase()));
  const projectFilter = filters.project;
  const selectedProjects = projectFilter ? projects.filter((project) => projectFilter.toLowerCase() === 'current'
    ? project.id === input.activeProjectId
    : matches(projectFilter, [project.id, project.label, project.normalizedPath, project.normalizedPath.split('/').pop()])) : projects;
  const scopedDirectories = new Set<string>();
  for (const project of selectedProjects) {
    if (!filters.worktree) scopedDirectories.add(project.normalizedPath);
    for (const worktree of worktrees.get(project.id) ?? []) {
      if (!filters.worktree || matches(filters.worktree, [worktree.path, worktree.label, worktree.name, worktree.branch])) scopedDirectories.add(normalizePath(worktree.path) ?? worktree.path);
    }
  }
  const scoped = Boolean(filters.project || filters.worktree);
  const admits = (directory: string | null): boolean => {
    const normalized = normalizePath(directory);
    if (!normalized || (isVSCode && !knownDirectories.has(normalized))) return false;
    if (scoped) return scopedDirectories.has(normalized);
    if (knownDirectories.has(normalized)) return true;
    let candidate: string | null = normalized;
    while (candidate) {
      if (scopedDirectories.has(candidate)) return true;
      const slash = candidate.lastIndexOf('/');
      candidate = slash > 0 ? candidate.slice(0, slash) : null;
    }
    return false;
  };
  // Retain known nested destinations under their authoritative owner, including linked worktrees outside the root.
  if (scoped && !filters.worktree) {
    const projectIds = new Set(selectedProjects.map((project) => project.id));
    const sessionsById = new Map(sessions.map((session) => [session.id, session]));
    for (const [id, owner] of owners) if (projectIds.has(owner.projectId)) {
      const session = sessionsById.get(id);
      const directory = normalizePath(session?.directory);
      if (directory && (knownDirectories.has(directory) || (scopedDirectories.has(owner.scopeDirectory)
        && (directory === owner.scopeDirectory || directory.startsWith(`${owner.scopeDirectory}/`))))) scopedDirectories.add(directory);
    }
  }
  const directories = scoped ? [...scopedDirectories].filter((directory) => !isVSCode || knownDirectories.has(directory)).sort() : isVSCode ? [...knownDirectories].sort() : undefined;
  const available = directories === undefined || directories.length > 0;
  return { directories, available, isAdmitted: admits };
}

export function sidebarSearchMetadata(input: {
  sessions: readonly Session[];
  lifecycle: NonNullable<OmniFilters['lifecycle']>;
  isAdmitted: (directory: string | null) => boolean;
  owners: ReadonlyMap<string, DirectoryOwner>;
  projects: readonly SearchProject[];
  worktrees: ReadonlyMap<string, WorktreeMetadata[]>;
}): ConversationMetadata[] {
  const seen = new Set<string>();
  const projects = new Map(input.projects.map((project) => [project.id, project]));
  return input.sessions.flatMap((session) => {
    const directory = normalizePath(session.directory);
    const archived = Boolean(session.time?.archived);
    if (seen.has(session.id) || !input.isAdmitted(directory) || (input.lifecycle !== 'all' && archived !== (input.lifecycle === 'archived'))) return [];
    seen.add(session.id);
    const owner = input.owners.get(session.id);
    const project = owner ? projects.get(owner.projectId) : undefined;
    const worktree = owner ? input.worktrees.get(owner.projectId)?.find((worktree) => normalizePath(worktree.path) === owner.scopeDirectory) : undefined;
    return [{ sessionId: session.id, title: session.title ?? '', directory, archived, projectLabel: project?.label ?? project?.normalizedPath.split('/').pop() ?? null, worktreeLabel: worktree?.branch ?? worktree?.name ?? null }];
  });
}

export function projectSidebarSearchGroups(groups: readonly SessionGroup[], matchedIds: ReadonlySet<string>): WeakMap<SessionGroup, GroupSearchData> {
  const result = new WeakMap<SessionGroup, GroupSearchData>();
  const filter = (nodes: readonly SessionNode[]): SessionNode[] => nodes.flatMap((node) => {
    const children = filter(node.children);
    return matchedIds.has(node.session.id) || children.length > 0 ? [{ ...node, children }] : [];
  });
  for (const group of groups) {
    const filteredNodes = filter(group.sessions);
    result.set(group, { filteredNodes, matchedSessionCount: filteredNodes.length, folderNameMatchCount: 0, groupMatches: false, hasMatch: filteredNodes.length > 0 });
  }
  return result;
}
