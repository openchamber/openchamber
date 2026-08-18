import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import type { SessionGroup, SessionNode } from '../types';
import { normalizePath } from '../utils';
import type { MainTab } from '@/stores/useUIStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

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
  handleSessionSelect: (sessionId: string, sessionDirectory: string | null) => void;
  newSessionDraftOpen: boolean;
  mobileVariant: boolean;
  openNewSessionDraft: (options?: { selectedProjectId?: string | null; directoryOverride?: string | null }) => void;
  setActiveMainTab: (tab: MainTab) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
};

export type MissingProjectSessionSelection =
  | { kind: 'preserve-current' }
  | { kind: 'open-draft' }
  | { kind: 'select-session'; sessionId: string }
  | { kind: 'none' };

/**
 * Resolves the active-project action after its rendered session map does not
 * contain the current session.
 *
 * Authoritative ownership wins. If ownership is still unknown, a session that
 * already appears under another project's rendered map is treated as foreign,
 * while a session missing from every rendered map is preserved so stale
 * worktree metadata can catch up.
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
    const projectMap = projectSessionMeta.metaByProject.get(activeProjectId);

    if (currentSessionId && projectMap && projectMap.has(currentSessionId)) {
      previousActiveProjectRef.current = activeProjectId;
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

    // Keep the project unprocessed while ownership/maps may still catch up,
    // so a later owner of another project can still select B.
    if (selection.kind === 'preserve-current') {
      if (currentSessionOwnerProjectId === activeProjectId) {
        previousActiveProjectRef.current = activeProjectId;
      }
      return;
    }

    previousActiveProjectRef.current = activeProjectId;

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
    handleSessionSelect(selection.sessionId, targetDirectory);
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

type ProjectSessionSelectionEffectProps = Omit<
  Args,
  'activeSessionByProject' | 'setActiveSessionByProject' | 'currentSessionId' | 'newSessionDraftOpen' | 'currentSessionOwnerProjectId'
> & {
  initialActiveSessionByProject: Map<string, string>;
  persistActiveSessionByProject: (value: Map<string, string>) => void;
  sessionOwnerBySessionId?: ReadonlyMap<string, { projectId: string }>;
};

export const ProjectSessionSelectionEffect: React.FC<ProjectSessionSelectionEffectProps> = ({
  initialActiveSessionByProject,
  persistActiveSessionByProject,
  sessionOwnerBySessionId,
  ...args
}) => {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const newSessionDraftOpen = useSessionUIStore((state) => Boolean(state.newSessionDraft?.open));
  const currentSessionOwnerProjectId = currentSessionId
    ? sessionOwnerBySessionId?.get(currentSessionId)?.projectId ?? null
    : null;
  const [activeSessionByProject, setActiveSessionByProject] = React.useState(
    () => new Map(initialActiveSessionByProject),
  );
  useProjectSessionSelection({
    ...args,
    activeSessionByProject,
    setActiveSessionByProject,
    currentSessionId,
    currentSessionOwnerProjectId,
    newSessionDraftOpen,
  });
  React.useEffect(() => {
    persistActiveSessionByProject(activeSessionByProject);
  }, [activeSessionByProject, persistActiveSessionByProject]);
  return null;
};
