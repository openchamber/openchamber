import React from 'react';
import { CodeMirrorEditor } from '@/components/ui/CodeMirrorEditor';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { OverlayScrollbar } from '@/components/ui/OverlayScrollbar';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { ActionToolbar, type ToolbarAction } from '@/components/ui/action-toolbar';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { PlanProgressLabel } from '@/components/session/project-context/PlansSection';
import { usePlanActions } from '@/components/session/project-context/usePlanActions';
import { useSessionKnowledgePins } from '@/components/session/project-context/useSessionKnowledgePins';
import { PlanTodos } from '@/components/session/project-context/PlanTodos';
import { registerOpenPlan } from '@/components/session/project-context/openPlanViews';
import { buildCodeMirrorCommentWidgets, FilePreviewCommentMenu, normalizeLineRange, useInlineCommentController, useLineNumberDragSelection } from '@/components/comments';

import { useDeviceInfo } from '@/lib/device';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { createFlexokiCodeMirrorTheme } from '@/lib/codemirror/flexokiTheme';
import { languageByExtension } from '@/lib/codemirror/languageByExtension';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessions } from '@/sync/sync-context';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSelectionStore } from '@/sync/selection-store';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionGoalArmStore } from '@/stores/useSessionGoalArmStore';
import { useUIStore } from '@/stores/useUIStore';
import { useGitStore } from '@/stores/useGitStore';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { EditorView } from '@codemirror/view';
import { copyTextToClipboard } from '@/lib/clipboard';
import { generateBranchName } from '@/lib/git/branchNameGenerator';
import { fetchProjectPlan, parsePlanMarkdown, resolveProjectContextId, type SavedProjectPlanTarget } from '@/lib/projectContextApi';
import { CHAT_DRAFT_PROJECT_ID } from '@/lib/chatDirectories';
import { createPlanSaveQueue } from '@/lib/planSaveQueue';
import { createFileContentPoller } from './fileContentPoller';
import { observeProjectContext } from '@/lib/projectContextSync';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useProjectContextStore } from '@/stores/useProjectContextStore';
import { createWorktreeSessionForNewBranch } from '@/lib/worktreeSessionCreator';
import { TodoSendDialog } from '@/components/session/TodoSendDialog';
import { resolveExecutionForDirectory, type TodoSendExecution } from '@/components/session/todoSendExecution';
import { useMessageTTS } from '@/hooks/useMessageTTS';
import { toast } from '@/components/ui';
import { loadMagicPrompts, type MagicPromptSnapshot } from '@/lib/magicPrompts';
import { useI18n } from '@/lib/i18n';
import { ContextPanelHeaderToolbar } from '@/components/layout/contextPanelHeaderSlot';
import { useInContextPanelHeader } from '@/components/layout/contextPanelHeaderSlotContext';
import { cn } from '@/lib/utils';
import { useMarkdownLocalAssets } from './files/previews/useMarkdownLocalAssets';
import { watchFileOnScreen } from '@/lib/watchedFiles';

const WATCHED_PLAN_POLL_MS = 30_000;

type PlanViewProps = {
  visible?: boolean;
  savedProjectPlan?: SavedProjectPlanTarget | null;
  onNavigatedToChat?: () => void;
  leading?: React.ReactNode;
  onClose?: () => void;
};

const NO_PROJECT = { id: '', path: '' };

const LEADING_HEADING = /^\s*#\s+.+?(?:\n+|$)/;

type PlanSendAction = 'improve' | 'implement';
type PlanSendTarget = 'session' | 'worktree';

type PendingPlanSend = {
  action: PlanSendAction;
  target: PlanSendTarget;
};

const normalize = (value: string): string => {
  if (!value) return '';
  const replaced = value.replace(/\\/g, '/');
  return replaced === '/' ? '/' : replaced.replace(/\/+$/, '');
};

const resolveProjectRefForDirectory = (
  directory: string,
  projects: Array<{ id: string; path: string }>,
  activeProjectId: string | null,
): { id: string; path: string } | null => {
  const normalized = normalize(directory.trim());
  if (!normalized) {
    return null;
  }

  const activeProject = activeProjectId
    ? projects.find((project) => project.id === activeProjectId) ?? null
    : null;

  if (activeProject?.path) {
    const activePath = normalize(activeProject.path);
    if (normalized === activePath || normalized.startsWith(`${activePath}/`)) {
      return { id: activeProject.id, path: activeProject.path };
    }
  }

  const match = projects
    .filter((project) => {
      const projectPath = normalize(project.path);
      return normalized === projectPath || normalized.startsWith(`${projectPath}/`);
    })
    .sort((left, right) => normalize(right.path).length - normalize(left.path).length)[0];

  return match ? { id: match.id, path: match.path } : null;
};

const savePlanDocument = async (target: SavedProjectPlanTarget, text: string): Promise<void> => {
  const saved = await useProjectContextStore.getState().savePlan(target.projectRef, target.planId, text);
  if (!saved) {
    throw new Error('Plan save rejected: the plan no longer exists');
  }
};

const subscribeActiveRuntimeKey = (onStoreChange: () => void): (() => void) => {
  return subscribeRuntimeEndpointChanged(() => onStoreChange());
};

type SelectedLineRange = {
  start: number;
  end: number;
};

export const PlanView: React.FC<PlanViewProps> = ({ visible = true, savedProjectPlan = null, onNavigatedToChat, leading, onClose }) => {
  const { t } = useI18n();
  const inPanelHeader = useInContextPanelHeader();
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const createSession = useSessionUIStore((state) => state.createSession);
  const initializeNewOpenChamberSession = useSessionUIStore((state) => state.initializeNewOpenChamberSession);
  const sendMessage = useSessionUIStore((state) => state.sendMessage);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const sessions = useSessions();
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const gitDirectories = useGitStore((state) => state.directories);
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const setSessionSwitcherOpen = useUIStore((state) => state.setSessionSwitcherOpen);
  const activeRuntimeKey = React.useSyncExternalStore(subscribeActiveRuntimeKey, getRuntimeKey, getRuntimeKey);
  const { isMobile } = useDeviceInfo();
  const { currentTheme } = useThemeSystem();

  const session = React.useMemo(() => {
    if (!currentSessionId) return null;
    return sessions.find((s) => s.id === currentSessionId) ?? null;
  }, [currentSessionId, sessions]);

  const sessionDirectory = React.useMemo(() => {
    const raw = typeof session?.directory === 'string' ? session.directory : '';
    return normalize(raw || '');
  }, [session?.directory]);
  const projectDirectory = React.useMemo(
    () => normalize(effectiveDirectory || sessionDirectory),
    [effectiveDirectory, sessionDirectory],
  );
  const currentProjectRef = React.useMemo(
    () => resolveProjectRefForDirectory(projectDirectory, projects, activeProjectId),
    [activeProjectId, projectDirectory, projects],
  );
  const savedPlanProjectId = savedProjectPlan?.projectRef.id ?? null;
  const savedPlanProjectPath = savedProjectPlan?.projectRef.path ?? null;
  const savedPlanProjectRef = React.useMemo(
    () => savedPlanProjectId && savedPlanProjectPath
      ? { id: savedPlanProjectId, path: savedPlanProjectPath }
      : null,
    [savedPlanProjectId, savedPlanProjectPath],
  );
  const savedPlanId = savedProjectPlan?.planId ?? null;
  const planLink = useProjectContextStore((state) => {
    if (!savedPlanProjectRef || !savedPlanId) return null;
    return state.entries[resolveProjectContextId(savedPlanProjectRef)]?.plans.find((plan) => plan.id === savedPlanId) ?? null;
  });
  const planActions = usePlanActions(savedPlanProjectRef ?? NO_PROJECT);
  const { pinnedPlanIds, togglePin } = useSessionKnowledgePins();
  const togglePlanPin = React.useCallback(async (planId: string, pinned: boolean) => {
    if (!await togglePin('plan', planId, pinned)) toast.error(t('rightSidebar.contextNotesTodo.toast.updatePlanFailed'));
  }, [t, togglePin]);
  const savedPlanKey = savedPlanProjectRef && savedPlanId
    ? JSON.stringify(['saved-plan', activeRuntimeKey, resolveProjectContextId(savedPlanProjectRef), savedPlanId])
    : null;
  const isManagedChatPlan = savedPlanProjectRef?.id === CHAT_DRAFT_PROJECT_ID;
  const canCreateWorktree = React.useMemo(
    () => {
      const sendTarget = savedPlanProjectRef ?? currentProjectRef;
      return sendTarget ? gitDirectories.get(sendTarget.path)?.isGitRepo === true : false;
    },
    [currentProjectRef, gitDirectories, savedPlanProjectRef],
  );
  const [pendingPlanSend, setPendingPlanSend] = React.useState<PendingPlanSend | null>(null);
  const [isPlanSendSubmitting, setIsPlanSendSubmitting] = React.useState(false);

  const [loadedProjectPlanId, setLoadedProjectPlanId] = React.useState<string | null>(null);
  const [loadedProjectPlanPath, setLoadedProjectPlanPath] = React.useState<string | null>(null);
  const hasDocument = Boolean(loadedProjectPlanId);
  const [content, setContent] = React.useState<string>('');
  const { isPlaying: isTTSPlaying, play: playTTS, stop: stopTTS } = useMessageTTS();
  const showMessageTTSButtons = useConfigStore((state) => state.showMessageTTSButtons);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const planFileLabel = t('planView.file.defaultName');
  const commentFileLabel = loadedProjectPlanPath ?? planFileLabel;
  const parsedTitle = React.useMemo(() => {
    if (!content.trim()) {
      return t('planView.title.default');
    }
    return parsePlanMarkdown(content, t('planView.title.default')).title;
  }, [content, t]);
  const previewContent = React.useMemo(() => {
    const heading = LEADING_HEADING.exec(content);
    return heading ? content.slice(heading[0].length) : content;
  }, [content]);
  const sendPromptTitle = React.useMemo(() => parsedTitle.trim() || t('planView.title.default'), [parsedTitle, t]);
  const [loading, setLoading] = React.useState(false);
  const [mdViewMode, setMdViewMode] = React.useState<'preview' | 'edit'>('preview');
  const [startsEmpty, setStartsEmpty] = React.useState(false);
  const viewMode = startsEmpty ? 'edit' : mdViewMode;

  const [lineSelection, setLineSelection] = React.useState<SelectedLineRange | null>(null);
  const editorViewRef = React.useRef<EditorView | null>(null);
  const editorWrapperRef = React.useRef<HTMLDivElement | null>(null);
  const previewRef = React.useRef<HTMLDivElement | null>(null);
  const setPreviewContainer = React.useCallback((node: HTMLDivElement | null) => {
    previewRef.current = node;
  }, []);

  const openLinkedFile = React.useCallback((absolutePath: string) => {
    if (!savedPlanProjectRef?.path) return;
    useUIStore.getState().openContextFile(savedPlanProjectRef.path, absolutePath);
  }, [savedPlanProjectRef]);
  const markdownDocumentAssets = useMarkdownLocalAssets({
    filePath: loadedProjectPlanPath,
    workspaceRoot: savedPlanProjectRef?.path ?? null,
    onOpenFile: openLinkedFile,
    enabled: viewMode === 'preview' && hasDocument,
    colorScheme: currentTheme.metadata.variant === 'light' ? 'light' : 'dark',
  });

  const MD_VIEWER_MODE_KEY = 'openchamber:plan:md-viewer-mode';

  React.useEffect(() => {
    try {
      const stored = localStorage.getItem(MD_VIEWER_MODE_KEY);
      if (!stored) return;
      const parsed = JSON.parse(stored) as unknown;
      if (parsed === 'preview' || parsed === 'edit') {
        setMdViewMode(parsed);
      }
    } catch {
      // ignore
    }
  }, []);

  const saveMdViewMode = React.useCallback((mode: 'preview' | 'edit') => {
    setStartsEmpty(false);
    setMdViewMode(mode);
    try {
      localStorage.setItem(MD_VIEWER_MODE_KEY, JSON.stringify(mode));
    } catch {
      // ignore
    }
  }, []);
  const extractSelectedCode = React.useCallback((text: string, range: SelectedLineRange): string => {
    const lines = text.split('\n');
    const startLine = Math.max(1, range.start);
    const endLine = Math.min(lines.length, range.end);
    if (startLine > endLine) return '';
    return lines.slice(startLine - 1, endLine).join('\n');
  }, []);

  const commentController = useInlineCommentController<SelectedLineRange>({
    source: 'plan',
    fileLabel: commentFileLabel,
    language: 'markdown',
    getCodeForRange: (range) => extractSelectedCode(content, normalizeLineRange(range)),
    toStoreRange: (range) => ({ startLine: range.start, endLine: range.end }),
    fromDraftRange: (draft) => ({ start: draft.startLine, end: draft.endLine }),
  });

  const {
    drafts: planFileDrafts,
    commentText,
    setCommentText,
    editingDraftId,
    setSelection: setCommentSelection,
    saveComment,
    cancel,
    reset,
    startEdit,
    deleteDraft,
  } = commentController;

  const { isDragging, lineNumbersConfig, isDragReleaseClick } = useLineNumberDragSelection({
    lineSelection,
    setLineSelection,
    onClear: cancel,
    isMobile,
  });

  React.useEffect(() => {
    setLineSelection(null);
    reset();
  }, [content, reset]);

  React.useEffect(() => {
    setCommentSelection(lineSelection);
  }, [lineSelection, setCommentSelection]);

  const handleCancelComment = React.useCallback(() => {
    setLineSelection(null);
    cancel();
  }, [cancel]);

  const handleSaveComment = React.useCallback((textToSave: string, rangeOverride?: { start: number; end: number }) => {
    if (rangeOverride) {
      setLineSelection(rangeOverride);
    }
    const saved = saveComment(textToSave, rangeOverride ?? lineSelection ?? undefined);
    if (saved) setLineSelection(null);
    return saved;
  }, [lineSelection, saveComment]);

  React.useEffect(() => {
    if (!lineSelection) return;

    if (isMobile && !editingDraftId) {
      // Input handles mobile scroll/focus behavior.
    }

    const handleClickOutside = (e: MouseEvent) => {
      if (isDragReleaseClick()) return;
      const target = e.target as HTMLElement;
      if (
        target.closest('[data-comment-card="true"]') ||
        target.closest('[data-comment-input="true"]') ||
        target.closest('.oc-block-widget')
      ) {
        return;
      }

      if (target.closest('.cm-gutterElement')) return;
      if (target.closest('[data-sonner-toast]') || target.closest('[data-sonner-toaster]')) return;

      if (!commentText.trim()) {
        setLineSelection(null);
        cancel();
      }
    };

    const timeoutId = window.setTimeout(() => {
      document.addEventListener('click', handleClickOutside);
    }, 100);

    return () => {
      window.clearTimeout(timeoutId);
      document.removeEventListener('click', handleClickOutside);
    };
  }, [cancel, commentText, editingDraftId, isDragReleaseClick, isMobile, lineSelection]);

  const editorFontSize = useUIStore((state) => state.editorFontSize);

  const editorExtensions = React.useMemo(() => {
    const extensions = [createFlexokiCodeMirrorTheme(currentTheme, { fontSize: editorFontSize })];
    const language = languageByExtension('plan.md');
    if (language) {
      extensions.push(language);
    }
    extensions.push(EditorView.lineWrapping);
    return extensions;
  }, [currentTheme, editorFontSize]);

  const docRef = React.useRef<{
    key: string | null;
    target: SavedProjectPlanTarget | null;
    content: string;
    editRevision: number;
    savedRevision: number;
    runtimeKey: string;
  }>({ key: null, target: null, content: '', editRevision: 0, savedRevision: 0, runtimeKey: '' });
  const saveQueue = React.useState(createPlanSaveQueue)[0];

  const scheduleSave = React.useCallback(() => {
    const doc = docRef.current;
    if (!doc.key || !doc.target || doc.editRevision <= doc.savedRevision) {
      return;
    }
    const captured = {
      key: doc.key,
      target: doc.target,
      content: doc.content,
      revision: doc.editRevision,
      runtimeKey: doc.runtimeKey,
    };
    saveQueue.schedule(captured.key, captured.revision, async () => {
      if (getRuntimeKey() !== captured.runtimeKey) {
        return;
      }
      await savePlanDocument(captured.target, captured.content);
      const current = docRef.current;
      if (current.key === captured.key) {
        current.savedRevision = Math.max(current.savedRevision, captured.revision);
        setSaveError(null);
      }
    }).catch((error) => {
      if (docRef.current.key === captured.key) {
        setSaveError(error instanceof Error ? error.message : 'Plan save failed');
      }
    });
  }, [saveQueue]);

  React.useEffect(() => {
    if (!savedPlanId) {
      scheduleSave();
      docRef.current = { key: null, target: null, content: '', editRevision: 0, savedRevision: 0, runtimeKey: '' };
      setLoadedProjectPlanId(null);
      setLoadedProjectPlanPath(null);
      setContent('');
      setLoading(false);
      return;
    }

    let cancelled = false;

    const run = async () => {
      scheduleSave();
      docRef.current = { key: null, target: null, content: '', editRevision: 0, savedRevision: 0, runtimeKey: '' };
      setLoadedProjectPlanId(null);
      setLoadedProjectPlanPath(null);
      setContent('');
      setSaveError(null);
      setLoadError(null);

      if (!savedPlanProjectRef || !savedPlanKey) {
        return;
      }

      await saveQueue.pendingFor(savedPlanKey);
      if (cancelled) return;
      saveQueue.reset(savedPlanKey);
      setLoading(true);
      try {
        const plan = await fetchProjectPlan(savedPlanProjectRef, savedPlanId);
        if (cancelled) return;
        if (!plan) {
          setLoadError('Plan not found');
          return;
        }
        docRef.current = {
          key: savedPlanKey,
          target: { projectRef: savedPlanProjectRef, planId: savedPlanId },
          content: plan.raw,
          editRevision: 0,
          savedRevision: 0,
          runtimeKey: activeRuntimeKey,
        };
        setContent(plan.raw);
        setStartsEmpty(!parsePlanMarkdown(plan.raw, '').body.trim());
        setLoadedProjectPlanId(savedPlanId);
        setLoadedProjectPlanPath(plan.path ?? null);
      } catch (error) {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : 'Plan load failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [activeRuntimeKey, savedPlanId, savedPlanKey, savedPlanProjectRef, saveQueue, scheduleSave]);

  const [heldForMove, setHeldForMove] = React.useState(false);
  React.useEffect(() => {
    if (!savedPlanProjectRef || !savedPlanId || !savedPlanKey || loadedProjectPlanId !== savedPlanId) return;
    return registerOpenPlan(resolveProjectContextId(savedPlanProjectRef), savedPlanId, {
      setHeld: setHeldForMove,
      flush: async () => {
        scheduleSave();
        await saveQueue.pendingFor(savedPlanKey);
        const doc = docRef.current;
        return doc.key === savedPlanKey && doc.savedRevision >= doc.editRevision;
      },
    });
  }, [loadedProjectPlanId, savedPlanId, savedPlanKey, savedPlanProjectRef, saveQueue, scheduleSave]);

  React.useEffect(() => {
    if (!visible || !savedPlanProjectRef || !savedPlanId || !savedPlanKey || loadedProjectPlanId !== savedPlanId) return;
    const doc = docRef.current;
    if (doc.key !== savedPlanKey) return;
    const poller = createFileContentPoller({
      readContent: async () => {
        await saveQueue.pendingFor(savedPlanKey);
        const plan = await fetchProjectPlan(savedPlanProjectRef, savedPlanId);
        if (!plan) throw new Error('Plan not found');
        return plan.raw;
      },
      getLoadedContent: () => doc.content,
      getLoadedRevision: () => doc.editRevision,
      isDirty: () => docRef.current !== doc || doc.editRevision > doc.savedRevision,
      applyContent: (raw) => {
        doc.content = raw;
        setContent(raw);
      },
    });
    let polling = false;
    let pollAgain = false;
    const poll = async () => {
      if (document.visibilityState === 'hidden') return;
      if (polling) {
        pollAgain = true;
        return;
      }
      polling = true;
      try {
        await poller.poll();
      } finally {
        polling = false;
        if (pollAgain) {
          pollAgain = false;
          void poll();
        }
      }
    };
    const release = observeProjectContext(savedPlanProjectRef, poll);
    let interval = window.setInterval(() => { void poll(); }, 2000);
    const watch = loadedProjectPlanPath
      ? watchFileOnScreen(savedPlanProjectRef.path, loadedProjectPlanPath, () => { void poll(); })
      : null;
    let stopped = false;
    void watch?.watching.then((watching) => {
      if (!watching || stopped) return;
      window.clearInterval(interval);
      interval = window.setInterval(() => { void poll(); }, WATCHED_PLAN_POLL_MS);
    });
    return () => {
      stopped = true;
      window.clearInterval(interval);
      watch?.stop();
      release();
      poller.dispose();
    };
  }, [loadedProjectPlanId, loadedProjectPlanPath, savedPlanId, savedPlanKey, savedPlanProjectRef, saveQueue, visible]);

  const handleContentChange = React.useCallback((next: string) => {
    if (next === docRef.current.content) return;
    docRef.current.content = next;
    docRef.current.editRevision += 1;
    setContent(next);
  }, []);

  React.useEffect(() => {
    if (!loadedProjectPlanId) {
      return;
    }

    const controller = window.setTimeout(() => {
      scheduleSave();
    }, 350);

    return () => {
      window.clearTimeout(controller);
    };
  }, [content, loadedProjectPlanId, scheduleSave]);

  React.useEffect(() => {
    return () => {
      scheduleSave();
    };
  }, [scheduleSave]);

  const routeToChat = React.useCallback(() => {
    setSessionSwitcherOpen(false);
    onNavigatedToChat?.();
  }, [onNavigatedToChat, setSessionSwitcherOpen]);

  const handleConfirmPlanSend = React.useCallback(
    async (dialogExecution: TodoSendExecution) => {
      const sendTargetProject = savedPlanProjectRef ?? currentProjectRef;
      if (!sendTargetProject || !pendingPlanSend || isManagedChatPlan) {
        return;
      }

      const planFilePath = loadedProjectPlanPath;
      setIsPlanSendSubmitting(true);

      try {
        let prompts: MagicPromptSnapshot;
        try {
          prompts = await loadMagicPrompts(sendTargetProject.path);
        } catch (error) {
          toast.error(t('magicPrompts.toast.loadFailed'), { description: error instanceof Error ? error.message : undefined });
          return;
        }
        const visiblePrompt = prompts.render(
          pendingPlanSend.action === 'improve' ? 'plan.improve.visible' : 'plan.implement.visible',
          {
            plan_title: sendPromptTitle,
          },
        );
        const instructionsText = prompts.render(
          pendingPlanSend.action === 'improve' ? 'plan.improve.instructions' : 'plan.implement.instructions',
          {
            plan_title: sendPromptTitle,
            plan_path: planFilePath ?? '',
          },
        );
        const planSubstance = planFilePath
          ? instructionsText
          : [
              instructionsText,
              '',
              'The plan is not stored as a file in the repository and has no file path. Its full current contents follow below this note and are the source of truth for the plan. Where the instructions above refer to the plan file, treat the plan as stored in OpenChamber project knowledge (it is edited through the OpenChamber UI): propose plan revisions as plan text in the chat rather than editing a file.',
              '',
              content,
            ].join('\n');
        const syntheticParts = [{ synthetic: true as const, text: planSubstance }];

        routeToChat();

        let sessionId: string | null = null;
        let directoryHint: string | null = sendTargetProject.path;
        let execution = dialogExecution;

        if (pendingPlanSend.target === 'worktree') {
          if (!canCreateWorktree) {
            return;
          }
          const created = await createWorktreeSessionForNewBranch(sendTargetProject.path, generateBranchName());
          if (!created?.id) {
            return;
          }
          sessionId = created.id;
          directoryHint = created.directory;
          execution = await resolveExecutionForDirectory(created.directory, dialogExecution);
        } else {
          const sessionResult = await createSession(undefined, sendTargetProject.path, undefined, {
            model: { providerID: execution.providerID, id: execution.modelID, variant: execution.variant || undefined },
            agent: execution.agent.trim() || undefined,
          });
          if (!sessionResult?.id) {
            return;
          }
          sessionId = sessionResult.id;
          directoryHint = sessionResult.directory ?? sendTargetProject.path;
          initializeNewOpenChamberSession(sessionResult.id, useConfigStore.getState().agents ?? []);
        }

        if (!sessionId) {
          return;
        }

        const selectionState = useSelectionStore.getState();
        selectionState.saveSessionModelSelection(sessionId, execution.providerID, execution.modelID);
        if (execution.agent.trim()) {
          selectionState.saveSessionAgentSelection(sessionId, execution.agent);
          selectionState.saveAgentModelForSession(sessionId, execution.agent, execution.providerID, execution.modelID);
          selectionState.saveAgentModelVariantForSession(
            sessionId,
            execution.agent,
            execution.providerID,
            execution.modelID,
            execution.variant || undefined,
          );
        }

        setCurrentSession(sessionId, directoryHint);
        if (savedPlanProjectRef && savedPlanId) {
          void useProjectContextStore.getState().linkPlanSession(savedPlanProjectRef, savedPlanId, sessionId);
        }
        const runAsGoal = pendingPlanSend.action === 'implement' && execution.runAsGoal === true;
        const goalObjective = runAsGoal
          ? [
              `Implement the plan "${sendPromptTitle}" end-to-end${planFilePath ? ` (plan file: ${planFilePath})` : ' (the full plan follows)'}.`,
              planFilePath
                ? 'Re-read that file for full details — it is the source of truth.'
                : 'The full plan follows in this message and is the source of truth.',
              '',
              content,
            ].join('\n')
          : null;
        useSessionGoalArmStore.getState().setArmed(runAsGoal, goalObjective);
        await sendMessage(
          visiblePrompt,
          execution.providerID,
          execution.modelID,
          execution.agent.trim() || undefined,
          undefined,
          undefined,
          syntheticParts,
          execution.variant || undefined,
        );

        setPendingPlanSend(null);
      } finally {
        setIsPlanSendSubmitting(false);
      }
    },
    [canCreateWorktree, content, createSession, currentProjectRef, initializeNewOpenChamberSession, isManagedChatPlan, loadedProjectPlanPath, pendingPlanSend, routeToChat, savedPlanId, savedPlanProjectRef, sendMessage, sendPromptTitle, setCurrentSession, t]
  );

  const blockWidgets = React.useMemo(() => {
    return buildCodeMirrorCommentWidgets({
      drafts: planFileDrafts,
      editingDraftId,
      commentText,
      onTextChange: setCommentText,
      selection: lineSelection,
      isDragging,
      fileLabel: planFileLabel,
      newWidgetId: 'plan-new-comment-input',
      mapDraftToRange: (draft) => ({ start: draft.startLine, end: draft.endLine }),
      onSave: handleSaveComment,
      onCancel: handleCancelComment,
      onEdit: (draft) => {
        startEdit(draft);
        setLineSelection({ start: draft.startLine, end: draft.endLine });
      },
      onDelete: deleteDraft,
    });
  }, [commentText, deleteDraft, editingDraftId, handleCancelComment, handleSaveComment, isDragging, lineSelection, planFileDrafts, planFileLabel, setCommentText, startEdit]);

  const sendMenu = (action: 'improve' | 'implement') => (
    <>
      <DropdownMenuItem
        onClick={() => setPendingPlanSend({ action, target: 'session' })}
        disabled={isManagedChatPlan}
      >
        {t('planView.actions.sendToNewSession')}
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={() => setPendingPlanSend({ action, target: 'worktree' })}
        disabled={!canCreateWorktree}
      >
        {t('planView.actions.sendToNewWorktreeSession')}
      </DropdownMenuItem>
    </>
  );

  const copyPlanContents = async () => {
    const result = await copyTextToClipboard(content);
    if (result.ok) toast.success(t('planView.toast.copied'));
  };

  const entryActions: ToolbarAction[] = planLink && savedPlanProjectRef ? [
    {
      id: 'pin',
      label: pinnedPlanIds.has(planLink.id)
        ? t('rightSidebar.contextNotesTodo.pin.detach')
        : t('rightSidebar.contextNotesTodo.pin.attach'),
      icon: pinnedPlanIds.has(planLink.id) ? 'pushpin-2-fill' : 'pushpin-2',
      onSelect: () => void togglePlanPin(planLink.id, !pinnedPlanIds.has(planLink.id)),
    },
    ...planActions.actionsFor(planLink, { onDeleted: onClose }).filter((action) => action.id !== 'move').map((action): ToolbarAction => ({
      id: action.id,
      label: action.label,
      icon: action.id === 'open-session' ? 'chat-3' : 'delete-bin',
      disabled: action.disabled,
      destructive: action.destructive,
      onSelect: action.onSelect,
    })),
  ] : [];
  const sendDisabled = !previewContent.trim() || isManagedChatPlan;

  return (
    <div className="relative flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden bg-background">
      <ContextPanelHeaderToolbar>
      <div className={cn('flex min-w-0 items-center gap-2', inPanelHeader ? 'flex-1 py-1 pe-1' : 'border-b border-edge-muted px-3 py-1.5 flex-shrink-0')}>
        {leading}
        <ActionToolbar
          className="flex-1"
          start={(
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate typography-ui-label font-medium" dir="auto">{parsedTitle}</span>
                {planLink?.progress ? <PlanProgressLabel progress={planLink.progress} /> : null}
              </div>
              {loadError ? (
                <div className="typography-micro text-[color:var(--status-error)] truncate" title={loadError}>
                  {t('planView.error.loadFailed')}
                </div>
              ) : null}
              {saveError ? (
                <div className="typography-micro text-[color:var(--status-error)] truncate" title={saveError}>
                  {t('planView.error.saveFailed')}
                </div>
              ) : null}
            </div>
          )}
          status={hasDocument ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" size="xs" disabled={sendDisabled} className="typography-ui-label">
                  {t('planView.actions.implement')}
                  <Icon name="arrow-down-s" className="size-3.5 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {sendMenu('implement')}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : undefined}
          groups={hasDocument ? [
            [{
              id: 'mode',
              label: t('documentToolbar.preview'),
              icon: 'eye',
              pressed: viewMode === 'preview',
              onSelect: () => saveMdViewMode(viewMode === 'preview' ? 'edit' : 'preview'),
              pinned: true,
            }],
          ] : []}
          menuOnly={hasDocument ? [
            {
              id: 'improve',
              label: t('planView.actions.improve'),
              icon: 'loop-right-ai',
              disabled: sendDisabled,
              menu: sendMenu('improve'),
            },
            showMessageTTSButtons && {
              id: 'read-aloud',
              label: isTTSPlaying ? t('planView.tts.stopSpeaking') : t('planView.tts.readAloud'),
              icon: 'volume-up',
              iconClassName: isTTSPlaying ? 'text-[var(--primary-text)]' : undefined,
              onSelect: () => {
                if (isTTSPlaying) {
                  stopTTS();
                } else if (content.trim()) {
                  void playTTS(content);
                }
              },
            },
            {
              id: 'copy-contents',
              label: t('planView.actions.copyPlanContents'),
              icon: 'file-copy',
              onSelect: () => void copyPlanContents(),
            },
            ...entryActions,
          ] : []}
        />
      </div>
      </ContextPanelHeaderToolbar>

      <TodoSendDialog
        open={pendingPlanSend !== null}
        onOpenChange={(open) => {
          if (!open && !isPlanSendSubmitting) {
            setPendingPlanSend(null);
          }
        }}
        target={pendingPlanSend?.target ?? 'session'}
        projectDirectory={savedPlanProjectRef?.path ?? currentProjectRef?.path ?? null}
        submitting={isPlanSendSubmitting}
        allowRunAsGoal={pendingPlanSend?.action === 'implement'}
        onConfirm={handleConfirmPlanSend}
      />

      <div className="flex-1 min-h-0 min-w-0 relative">
        <ScrollableOverlay outerClassName="h-full min-w-0" className="h-full min-w-0">
          {loading ? (
            <div className="p-3 typography-ui text-muted-foreground">{t('planView.state.loading')}</div>
          ) : (
            <div className="relative h-full">
              <div className="h-full">
                {viewMode === 'preview' ? (
                  <>
                  <div className="overlay-scrollbar-target overlay-scrollbar-container h-full overflow-auto p-3" ref={setPreviewContainer}>
                    <FilePreviewCommentMenu
                      containerRef={previewRef}
                      filePath={commentFileLabel}
                      fileContent={content}
                    />
                    <ErrorBoundary
                      fallback={
                        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
                          <div className="mb-1 font-medium text-destructive">{t('planView.error.previewUnavailable')}</div>
                          <div className="text-sm text-muted-foreground">
                            {t('planView.error.switchToEditMode')}
                          </div>
                        </div>
                      }
                    >
                      <SimpleMarkdownRenderer content={previewContent} documentAssets={markdownDocumentAssets} className="typography-markdown-body" frontmatter="properties" enableFileReferences={false} />
                    </ErrorBoundary>
                  </div>
                  <OverlayScrollbar containerRef={previewRef} />
                  </>
                ) : (
                  <div className="relative h-full" ref={editorWrapperRef}>
                    <CodeMirrorEditor
                      value={content}
                      onChange={handleContentChange}
                      readOnly={heldForMove}
                      className="h-full"
                      extensions={editorExtensions}
                      onViewReady={(view) => { editorViewRef.current = view; }}
                      onViewDestroy={() => { editorViewRef.current = null; }}
                      blockWidgets={blockWidgets}
                      highlightLines={lineSelection
                        ? {
                          start: Math.min(lineSelection.start, lineSelection.end),
                          end: Math.max(lineSelection.start, lineSelection.end),
                        }
                        : undefined}
                      lineNumbersConfig={lineNumbersConfig}
                  />
                </div>
                )}
              </div>
            </div>
          )}
        </ScrollableOverlay>
      </div>
      {savedPlanProjectRef && savedPlanId && hasDocument ? <PlanTodos projectRef={savedPlanProjectRef} planId={savedPlanId} /> : null}
    </div>
  );
};
