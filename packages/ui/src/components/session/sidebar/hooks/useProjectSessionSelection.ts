import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import type { SessionGroup, SessionNode } from '../types';
import { normalizePath } from '../utils';

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
  handleSessionSelect: (sessionId: string, sessionDirectory: string | null, isMissingDirectory: boolean, projectId?: string | null) => void;
  isVSCode: boolean;
  newSessionDraftOpen: boolean;
  mobileVariant: boolean;
  openNewSessionDraft: (options?: { directoryOverride?: string | null }) => void;
  setActiveMainTab: (tab: 'chat' | 'plan' | 'git' | 'diff' | 'terminal' | 'files') => void;
  setSessionSwitcherOpen: (open: boolean) => void;
  sessions: Session[];
  worktreeMetadata: Map<string, { path?: string | null }>;
};

export const useProjectSessionSelection = (args: Args): { currentSessionDirectory: string | null } => {
  const {
    projectSections,
    activeProjectId,
    activeSessionByProject,
    setActiveSessionByProject,
    currentSessionId,
    handleSessionSelect,
    isVSCode,
    newSessionDraftOpen,
    mobileVariant,
    openNewSessionDraft,
    setActiveMainTab,
    setSessionSwitcherOpen,
    sessions,
    worktreeMetadata,
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
  const lastSeenActiveProjectRef = React.useRef<string | null>(null);

  React.useLayoutEffect(() => {
    if (!activeProjectId) {
      return;
    }

    const previousSeenProjectId = lastSeenActiveProjectRef.current;
    const isProjectSwitch = Boolean(previousSeenProjectId && previousSeenProjectId !== activeProjectId);
    lastSeenActiveProjectRef.current = activeProjectId;

    if (newSessionDraftOpen && (isVSCode || !isProjectSwitch)) {
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

    if (!projectMap || projectMap.size === 0) {
      setActiveMainTab('chat');
      if (mobileVariant) {
        setSessionSwitcherOpen(false);
      }
      openNewSessionDraft({ directoryOverride: section.project.normalizedPath });
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
    handleSessionSelect(targetSessionId, targetDirectory, false, activeProjectId);
  }, [
    activeProjectId,
    activeSessionByProject,
    currentSessionId,
    handleSessionSelect,
    isVSCode,
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

  const currentSessionDirectory = React.useMemo(() => {
    if (!currentSessionId) {
      return null;
    }
    const metadataPath = worktreeMetadata.get(currentSessionId)?.path;
    if (metadataPath) {
      return normalizePath(metadataPath) ?? metadataPath;
    }
    const activeSession = sessions.find((session) => session.id === currentSessionId);
    if (!activeSession) {
      return null;
    }
    return normalizePath((activeSession as Session & { directory?: string | null }).directory ?? null);
  }, [currentSessionId, sessions, worktreeMetadata]);

  return { currentSessionDirectory };
};
