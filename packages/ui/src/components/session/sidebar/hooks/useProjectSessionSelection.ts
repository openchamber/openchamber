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
  handleSessionSelect: (sessionId: string, sessionDirectory: string | null) => void;
  newSessionDraftOpen: boolean;
  mobileVariant: boolean;
  openNewSessionDraft: (options?: { selectedProjectId?: string | null; directoryOverride?: string | null }) => void;
  setActiveMainTab: (tab: MainTab) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
};

export const useProjectSessionSelection = (args: Args): void => {
  const {
    projectSections,
    activeProjectId,
    activeSessionByProject,
    setActiveSessionByProject,
    currentSessionId,
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

    // Path A' — currentSessionId is set but not in stale projectMap.
    // Preserve user's explicit selection when the projectMap exists but
    // is missing the session (worktree data not yet loaded). For
    // empty projects (projectMap is undefined), fall through to Path B
    // so a new session draft is opened.
    if (currentSessionId && projectMap) {
      return;
    }

    if (!projectMap || projectMap.size === 0) {
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

    const rememberedSessionId = activeSessionByProject.get(activeProjectId);
    const remembered = rememberedSessionId && projectMap.has(rememberedSessionId)
      ? rememberedSessionId
      : null;
    const fallback = projectSessionMeta.firstSessionByProject.get(activeProjectId)?.id ?? null;
    const targetSessionId = remembered ?? fallback;
    if (!targetSessionId || targetSessionId === currentSessionId) {
      return;
    }
    const targetDirectory = projectMap.get(targetSessionId)?.directory ?? null;
    handleSessionSelect(targetSessionId, targetDirectory);
  }, [
    activeProjectId,
    activeSessionByProject,
    currentSessionId,
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
  'activeSessionByProject' | 'setActiveSessionByProject' | 'currentSessionId' | 'newSessionDraftOpen'
> & {
  initialActiveSessionByProject: Map<string, string>;
  persistActiveSessionByProject: (value: Map<string, string>) => void;
};

export const ProjectSessionSelectionEffect: React.FC<ProjectSessionSelectionEffectProps> = ({
  initialActiveSessionByProject,
  persistActiveSessionByProject,
  ...args
}) => {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const newSessionDraftOpen = useSessionUIStore((state) => Boolean(state.newSessionDraft?.open));
  const [activeSessionByProject, setActiveSessionByProject] = React.useState(
    () => new Map(initialActiveSessionByProject),
  );
  useProjectSessionSelection({
    ...args,
    activeSessionByProject,
    setActiveSessionByProject,
    currentSessionId,
    newSessionDraftOpen,
  });
  React.useEffect(() => {
    persistActiveSessionByProject(activeSessionByProject);
  }, [activeSessionByProject, persistActiveSessionByProject]);
  return null;
};
