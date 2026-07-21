import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import type { SessionGroup, SessionNode } from '../types';
import { normalizePath } from '../utils';
import type { MainTab } from '@/stores/useUIStore';
import { useUIStore } from '@/stores/useUIStore';

type ProjectSection = {
  project: { id: string; normalizedPath: string };
  groups: SessionGroup[];
};

type Args = {
  projectSections: ProjectSection[];
  activeProjectId: string | null;
  activeSessionByProject: Map<string, string>;
  setActiveSessionByProject: React.Dispatch<React.SetStateAction<Map<string, string>>>;
  currentSessionId: string | null;
  currentSessionOwnerProjectId?: string | null;
  handleSessionSelect: (sessionId: string, sessionDirectory: string | null, projectId?: string | null) => void;
  newSessionDraftOpen: boolean;
  mobileVariant: boolean;
  openNewSessionDraft: (options?: { selectedProjectId?: string | null; directoryOverride?: string | null }) => void;
  setActiveMainTab: (tab: MainTab) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
};

type MissingProjectSessionSelection =
  | { kind: 'preserve-current' }
  | { kind: 'open-draft' }
  | { kind: 'select-session'; sessionId: string }
  | { kind: 'none' };

/**
 * Resolves the active-project action after its session map does not contain the
 * current session. An authoritative directory owner takes priority; otherwise,
 * rendered session maps preserve unknown sessions while worktree data catches up.
 */
export function resolveMissingProjectSessionSelection<T>({
  activeProjectId,
  currentSessionId,
  currentSessionOwnerProjectId,
  projectMap,
  metaByProject,
  rememberedSessionId,
  fallbackSessionId,
}: {
  activeProjectId: string;
  currentSessionId: string | null;
  currentSessionOwnerProjectId?: string | null;
  projectMap: ReadonlyMap<string, T> | undefined;
  metaByProject: ReadonlyMap<string, ReadonlyMap<string, T>>;
  rememberedSessionId: string | undefined;
  fallbackSessionId: string | null;
}): MissingProjectSessionSelection {
  if (currentSessionId && currentSessionOwnerProjectId === activeProjectId) {
    return { kind: 'preserve-current' };
  }

  if (currentSessionOwnerProjectId == null) {
    const currentSessionBelongsToAnotherProject = Boolean(
      currentSessionId
      && Array.from(metaByProject.entries()).some(
        ([projectId, sessions]) => projectId !== activeProjectId && sessions.has(currentSessionId),
      ),
    );
    if (currentSessionId && projectMap && !currentSessionBelongsToAnotherProject) {
      return { kind: 'preserve-current' };
    }
  }

  if (!projectMap || projectMap.size === 0) {
    return { kind: 'open-draft' };
  }

  const remembered = rememberedSessionId && projectMap.has(rememberedSessionId)
    ? rememberedSessionId
    : null;
  const targetSessionId = remembered ?? fallbackSessionId;
  if (!targetSessionId || targetSessionId === currentSessionId) {
    return { kind: 'none' };
  }

  return { kind: 'select-session', sessionId: targetSessionId };
}

export const useProjectSessionSelection = (args: Args): void => {
  const {
    projectSections,
    activeProjectId,
    activeSessionByProject,
    setActiveSessionByProject,
    currentSessionId,
    currentSessionOwnerProjectId,
    handleSessionSelect,
    newSessionDraftOpen,
    mobileVariant,
    openNewSessionDraft,
    setActiveMainTab,
    setSessionSwitcherOpen,
  } = args;

  const projectSessionMeta = React.useMemo(() => {
    const metaByProject = new Map<string, Map<string, { directory: string | null }>>();
    const firstSessionByProject = new Map<string, { id: string; directory: string | null }>();

    const visitNodes = (
      projectId: string,
      projectRoot: string,
      fallbackDirectory: string | null,
      nodes: SessionNode[],
    ) => {
      if (!metaByProject.has(projectId)) {
        metaByProject.set(projectId, new Map());
      }
      const projectMap = metaByProject.get(projectId)!;
      nodes.forEach((node) => {
        const sessionDirectory = normalizePath(
          node.worktree?.path
          ?? (node.session as Session & { directory?: string | null }).directory
          ?? fallbackDirectory
          ?? projectRoot,
        );
        projectMap.set(node.session.id, { directory: sessionDirectory });
        if (!firstSessionByProject.has(projectId)) {
          firstSessionByProject.set(projectId, { id: node.session.id, directory: sessionDirectory });
        }
        if (node.children.length > 0) {
          visitNodes(projectId, projectRoot, sessionDirectory, node.children);
        }
      });
    };

    projectSections.forEach((section) => {
      section.groups.forEach((group) => {
        visitNodes(section.project.id, section.project.normalizedPath, group.directory, group.sessions);
      });
    });

    return { metaByProject, firstSessionByProject };
  }, [projectSections]);

  const previousActiveProjectRef = React.useRef<string | null>(null);

  React.useLayoutEffect(() => {
    if (!activeProjectId) {
      return;
    }

    if (newSessionDraftOpen) {
      return;
    }

    if (useUIStore.getState().isNewWorktreeDialogOpen) {
      return;
    }

    if (previousActiveProjectRef.current === activeProjectId) {
      return;
    }

    const section = projectSections.find((item) => item.project.id === activeProjectId);
    if (!section) {
      return;
    }
    previousActiveProjectRef.current = activeProjectId;
    const projectMap = projectSessionMeta.metaByProject.get(activeProjectId);

    if (currentSessionId && projectMap && projectMap.has(currentSessionId)) {
      setActiveSessionByProject((prev) => {
        if (prev.get(activeProjectId) === currentSessionId) {
          return prev;
        }
        const next = new Map(prev);
        next.set(activeProjectId, currentSessionId);
        return next;
      });
      return;
    }

    const selection = resolveMissingProjectSessionSelection({
      activeProjectId,
      currentSessionId,
      currentSessionOwnerProjectId,
      projectMap,
      metaByProject: projectSessionMeta.metaByProject,
      rememberedSessionId: activeSessionByProject.get(activeProjectId),
      fallbackSessionId: projectSessionMeta.firstSessionByProject.get(activeProjectId)?.id ?? null,
    });

    if (selection.kind === 'preserve-current') {
      return;
    }

    if (selection.kind === 'open-draft') {
      setActiveMainTab('chat');
      if (mobileVariant) {
        setSessionSwitcherOpen(false);
      }
      openNewSessionDraft({
        selectedProjectId: section.project.id,
        directoryOverride: section.project.normalizedPath,
      });
      return;
    }

    if (selection.kind !== 'select-session') {
      return;
    }
    const targetDirectory = projectMap?.get(selection.sessionId)?.directory ?? null;
    handleSessionSelect(selection.sessionId, targetDirectory, activeProjectId);
  }, [
    activeProjectId,
    activeSessionByProject,
    currentSessionId,
    currentSessionOwnerProjectId,
    handleSessionSelect,
    newSessionDraftOpen,
    mobileVariant,
    openNewSessionDraft,
    projectSections,
    projectSessionMeta,
    setActiveMainTab,
    setSessionSwitcherOpen,
    setActiveSessionByProject,
  ]);

  React.useEffect(() => {
    if (!activeProjectId || !currentSessionId) {
      return;
    }
    const projectMap = projectSessionMeta.metaByProject.get(activeProjectId);
    if (!projectMap || !projectMap.has(currentSessionId)) {
      return;
    }
    setActiveSessionByProject((prev) => {
      if (prev.get(activeProjectId) === currentSessionId) {
        return prev;
      }
      const next = new Map(prev);
      next.set(activeProjectId, currentSessionId);
      return next;
    });
  }, [activeProjectId, currentSessionId, projectSessionMeta, setActiveSessionByProject]);

};
