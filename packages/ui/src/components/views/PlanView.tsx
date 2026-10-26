import React from 'react';
import { CodeMirrorEditor } from '@/components/ui/CodeMirrorEditor';
import { PreviewToggleButton } from './PreviewToggleButton';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { TodoSendDialog, type TodoSendExecution } from '@/components/session/TodoSendDialog';
import { Icon } from "@/components/icon/Icon";
import { useMessageTTS } from '@/hooks/useMessageTTS';
import { toast } from '@/components/ui';
import { loadMagicPrompts, type MagicPromptSnapshot } from '@/lib/magicPrompts';
import { useI18n } from '@/lib/i18n';
import { ContextPanelHeaderToolbar } from '@/components/layout/contextPanelHeaderSlot';
import { useInContextPanelHeader } from '@/components/layout/contextPanelHeaderSlotContext';
import { cn } from '@/lib/utils';
import { useMarkdownLocalAssets } from './files/previews/useMarkdownLocalAssets';

type PlanViewProps = {
  /** False while the panel holding the view is closed: nothing to keep fresh. */
  visible?: boolean;
  /** Saved project plan to open, with the project that owns it. The owner is
      part of the prop so the view never guesses it from the current directory:
      the Project knowledge panel and the mobile plan overlay keep a plan open
      across directory changes, and for managed chats the owner is not a
      registered project a directory lookup could ever find. */
  savedProjectPlan?: SavedProjectPlanTarget | null;
  /** Called after a send action routes the user to the chat — hosts that show
      PlanView in an overlay (mobile fullscreen surface) close it here. */
  onNavigatedToChat?: () => void;
  /** Rendered before the title, e.g. the project knowledge panel's back control. */
  leading?: React.ReactNode;
};

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

export const PlanView: React.FC<PlanViewProps> = ({ visible = true, savedProjectPlan = null, onNavigatedToChat, leading }) => {
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
  // Destructured to primitives so the load/save effects key on stable values
  // instead of a descriptor object rebuilt on every parent render.
  const savedPlanProjectId = savedProjectPlan?.projectRef.id ?? null;
  const savedPlanProjectPath = savedProjectPlan?.projectRef.path ?? null;
  const savedPlanProjectRef = React.useMemo(
    () => savedPlanProjectId && savedPlanProjectPath
      ? { id: savedPlanProjectId, path: savedPlanProjectPath }
      : null,
    [savedPlanProjectId, savedPlanProjectPath],
  );
  const savedPlanId = savedProjectPlan?.planId ?? null;
  // Stable logical identity, composed from primitives: an effect keyed on the
  // descriptor object would reload — and flush — the same plan whenever a
  // parent rebuilds the owner object with identical values.
  const savedPlanKey = savedPlanProjectRef && savedPlanId
    ? JSON.stringify(['saved-plan', activeRuntimeKey, resolveProjectContextId(savedPlanProjectRef), savedPlanId])
    : null;
  // Managed chats have no project directory to create a session in: their
  // sessions live in per-session directories under the chats root, which
  // createSession cannot prepare. Until a managed-chat send path exists,
  // Improve/Implement stay unavailable for plans stored under the Chats
  // owner — an OpenCode session created directly in the shared root would
  // break the managed-chats model.
  const isManagedChatPlan = savedPlanProjectRef?.id === CHAT_DRAFT_PROJECT_ID;
  const canCreateWorktree = React.useMemo(
    () => {
      // Worktree creation follows the session the plan would be sent to.
      const sendTarget = savedPlanProjectRef ?? currentProjectRef;
      return sendTarget ? gitDirectories.get(sendTarget.path)?.isGitRepo === true : false;
    },
    [currentProjectRef, gitDirectories, savedPlanProjectRef],
  );
  const [pendingPlanSend, setPendingPlanSend] = React.useState<PendingPlanSend | null>(null);
  const [isPlanSendSubmitting, setIsPlanSendSubmitting] = React.useState(false);

  // Set once a saved project plan has actually loaded.
  const [loadedProjectPlanId, setLoadedProjectPlanId] = React.useState<string | null>(null);
  // Where a saved plan's markdown lives, only to name it in comments: an
  // agent given just "plan" cannot tell which plan a comment is about.
  const [loadedProjectPlanPath, setLoadedProjectPlanPath] = React.useState<string | null>(null);
  const hasDocument = Boolean(loadedProjectPlanId);
  const [content, setContent] = React.useState<string>('');
  const { isPlaying: isTTSPlaying, play: playTTS, stop: stopTTS } = useMessageTTS();
  const showMessageTTSButtons = useConfigStore((state) => state.showMessageTTSButtons);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const planFileLabel = t('planView.file.defaultName');
  // Comments name the plan by its full path, as Files does for a file.
  const commentFileLabel = loadedProjectPlanPath ?? planFileLabel;
  const parsedTitle = React.useMemo(() => {
    if (!content.trim()) {
      return t('planView.title.default');
    }
    return parsePlanMarkdown(content, t('planView.title.default')).title;
  }, [content, t]);
  const sendPromptTitle = React.useMemo(() => parsedTitle.trim() || t('planView.title.default'), [parsedTitle, t]);
  const [loading, setLoading] = React.useState(false);
  const [copiedContent, setCopiedContent] = React.useState(false);
  const [mdViewMode, setMdViewMode] = React.useState<'preview' | 'edit'>('edit');
  const copiedContentTimeoutRef = React.useRef<number | null>(null);

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
    enabled: mdViewMode === 'preview' && hasDocument,
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
    saveComment(textToSave, rangeOverride ?? lineSelection ?? undefined);
    setLineSelection(null);
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

  // Pending-save bookkeeping for the open document. One ref record, not state:
  // debounced writes and close-time flushes must read the newest buffer and
  // revision without another render. `editRevision` advances on every editor
  // change; `savedRevision` only after a successful write of that exact
  // revision, so a slow in-flight save can never mark newer edits as saved.
  // `key` and `runtimeKey` make every write self-identifying: content never
  // crosses documents or runtimes, no matter when a queued write settles.
  const docRef = React.useRef<{
    key: string | null;
    target: SavedProjectPlanTarget | null;
    content: string;
    editRevision: number;
    savedRevision: number;
    runtimeKey: string;
  }>({ key: null, target: null, content: '', editRevision: 0, savedRevision: 0, runtimeKey: '' });
  const saveQueue = React.useState(createPlanSaveQueue)[0];

  // Queue any unflushed edits. Runs on document switches and on unmount, both
  // of which cancel the debounced save — without this the last 350ms of typing
  // is silently dropped. The queue orders it behind any write already in
  // flight for the same document, and the captured runtime key stops content
  // from one host being written into another after a runtime switch.
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
        // The runtime switched while this write waited: writing through the
        // new connection would land one host's edits on another.
        return;
      }
      await savePlanDocument(captured.target, captured.content);
      const current = docRef.current;
      if (current.key === captured.key) {
        current.savedRevision = Math.max(current.savedRevision, captured.revision);
        // A recovered save clears the stale failure banner.
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
      // Flush the outgoing document before the bookkeeping is replaced, so
      // edits typed within the debounce window survive a plan switch. React
      // reuses this component instance across saved-plan tabs.
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

      // A plan re-opened while its own flush is still writing must read the
      // post-write state, not race it. The queue reset afterwards is safe:
      // every write for this key has settled, and the reloaded document
      // restarts its revision counter at zero.
      await saveQueue.pendingFor(savedPlanKey);
      if (cancelled) return;
      saveQueue.reset(savedPlanKey);
      setLoading(true);
      try {
        const plan = await fetchProjectPlan(savedPlanProjectRef, savedPlanId);
        if (cancelled) return;
        if (!plan) {
          // The plan or its markdown is gone. Leave the view empty and
          // unsaveable rather than presenting an editor that would recreate
          // a document the user deleted.
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

  // An agent can change the open plan, through the knowledge tool or by
  // editing its file. With no unsaved edits the editor takes the new text, so
  // a later edit starts from it instead of writing the old document back over
  // it. Unsaved edits win: the next save replaces the agent's version, the way
  // typing in a note does. A save through the API announces itself; a file
  // edit does not, so the open plan also checks for one every two seconds, as
  // the file panel does for open files.
  React.useEffect(() => {
    if (!visible || !savedPlanProjectRef || !savedPlanId || !savedPlanKey || loadedProjectPlanId !== savedPlanId) return;
    const doc = docRef.current;
    if (doc.key !== savedPlanKey) return;
    const poller = createFileContentPoller({
      readContent: async () => {
        await saveQueue.pendingFor(savedPlanKey);
        const plan = await fetchProjectPlan(savedPlanProjectRef, savedPlanId);
        // A deleted plan keeps its text on screen; the next save reports it gone.
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
    const poll = async () => {
      if (polling || document.visibilityState === 'hidden') return;
      polling = true;
      try {
        await poller.poll();
      } finally {
        polling = false;
      }
    };
    const release = observeProjectContext(savedPlanProjectRef, poll);
    const interval = window.setInterval(() => { void poll(); }, 2000);
    return () => {
      window.clearInterval(interval);
      release();
      poller.dispose();
    };
  }, [loadedProjectPlanId, savedPlanId, savedPlanKey, savedPlanProjectRef, saveQueue, visible]);

  // Synchronous buffer tracking: if an edit and an unmount land in the same
  // batch, the passive content effect would never run and a flush would save
  // a stale buffer. The editor echoes text it was given as a change; that
  // echo is not an edit and must not schedule a save.
  const handleContentChange = React.useCallback((next: string) => {
    if (next === docRef.current.content) return;
    docRef.current.content = next;
    docRef.current.editRevision += 1;
    setContent(next);
  }, []);

  // The debounced write and the close/switch flush go through the same queue
  // (scheduleSave), so two saves of one document can never complete out of
  // order and a flush never duplicates a debounce of the same revision.
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

  // Closing the view inside the 350ms debounce window would drop the last
  // edits: the cleanup above cancels the timer. Same for switching documents,
  // which the load effect handles before replacing the bookkeeping.
  React.useEffect(() => {
    return () => {
      scheduleSave();
    };
  }, [scheduleSave]);

  React.useEffect(() => {
    return () => {
      if (copiedContentTimeoutRef.current !== null) {
        window.clearTimeout(copiedContentTimeoutRef.current);
      }
    };
  }, []);

  const routeToChat = React.useCallback(() => {
    setSessionSwitcherOpen(false);
    onNavigatedToChat?.();
  }, [onNavigatedToChat, setSessionSwitcherOpen]);

  const handleConfirmPlanSend = React.useCallback(
    async (execution: TodoSendExecution) => {
      // A saved plan sends against its own project — the one it is stored
      // under — not against whatever directory the viewer is currently in.
      const sendTargetProject = savedPlanProjectRef ?? currentProjectRef;
      if (!sendTargetProject || !pendingPlanSend || isManagedChatPlan) {
        return;
      }

      // A saved plan is a markdown file too, so the agent reads it and ticks
      // its steps there like any other plan file.
      const planFilePath = loadedProjectPlanPath;
      setIsPlanSendSubmitting(true);

      try {
        let prompts: MagicPromptSnapshot;
        try {
          // The plan's project owns the prompts, also when the session lands in a new worktree.
          prompts = await loadMagicPrompts(sendTargetProject.path);
        } catch (error) {
          // Nothing was created yet; the send dialog stays open with its choices.
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
        // A server that answered without the plan's path leaves the agent no
        // file to read, so the plan substance rides along in the message.
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
        // The plan's card leads to the session working on it. A failed link
        // costs only that shortcut, so it never holds up the send.
        if (savedPlanProjectRef && savedPlanId) {
          void useProjectContextStore.getState().linkPlanSession(savedPlanProjectRef, savedPlanId, sessionId);
        }
        // "Run as goal" rides the same arm mechanism as the composer target
        // button; set explicitly either way so a stray armed flag cannot
        // leak into a non-goal plan send. The objective override carries the
        // plan substance — "Implement this plan: X" alone would give the
        // progress audit nothing to judge against. Plans that exceed the
        // objective limit are distilled into completion criteria by the
        // small model (the working agent always reads the full plan from
        // its file); on distillation failure a head+tail excerpt keeps the
        // intent (top) and acceptance criteria (bottom), sacrificing the
        // implementation middle the agent reads from the file anyway.
        // Oversized objectives (huge plans) are distilled into audit
        // criteria inside setSessionGoal — the shared path for every goal
        // source. Here we only compose header + full content.
        // Improve stops before implementation, so only Implement runs as a goal.
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

  return (
    <div className="relative flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden bg-background">
      <ContextPanelHeaderToolbar>
      <div className={cn('flex min-w-0 items-center gap-2', inPanelHeader ? 'flex-1 py-1 pe-1' : 'border-b border-border/40 px-3 py-1.5 flex-shrink-0')}>
        {leading}
        <div className="min-w-0 flex-1">
          <div className="typography-ui-label font-medium truncate">{parsedTitle}</div>
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
        {hasDocument ? (
          <div className="flex items-center gap-1">
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 w-5 p-0"
                      aria-label={t('planView.actions.improvePlanAria')}
                      disabled={!content.trim() || isManagedChatPlan}
                    >
                      <Icon name="loop-right-ai" className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent sideOffset={8}>{t('planView.actions.improve')}</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => setPendingPlanSend({ action: 'improve', target: 'session' })}
                  disabled={isManagedChatPlan}
                >
                  {t('planView.actions.sendToNewSession')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setPendingPlanSend({ action: 'improve', target: 'worktree' })}
                  disabled={!canCreateWorktree}
                >
                  {t('planView.actions.sendToNewWorktreeSession')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 w-5 p-0"
                      aria-label={t('planView.actions.implementPlanAria')}
                      disabled={!content.trim() || isManagedChatPlan}
                    >
                      <Icon name="code-ai" className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent sideOffset={8}>{t('planView.actions.implement')}</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => setPendingPlanSend({ action: 'implement', target: 'session' })}
                  disabled={isManagedChatPlan}
                >
                  {t('planView.actions.sendToNewSession')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setPendingPlanSend({ action: 'implement', target: 'worktree' })}
                  disabled={!canCreateWorktree}
                >
                  {t('planView.actions.sendToNewWorktreeSession')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <PreviewToggleButton
              currentMode={mdViewMode}
              onToggle={() => saveMdViewMode(mdViewMode === 'preview' ? 'edit' : 'preview')}
            />
            {mdViewMode === 'preview' && showMessageTTSButtons && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 w-5 p-0"
                    aria-label={isTTSPlaying ? t('planView.tts.stopSpeaking') : t('planView.tts.readAloud')}
                    onClick={() => {
                      if (isTTSPlaying) {
                        stopTTS();
                      } else if (content.trim()) {
                        void playTTS(content);
                      }
                    }}
                  >
                    <Icon name="volume-up" className={isTTSPlaying ? 'h-4 w-4 text-[var(--primary-text)]' : 'h-4 w-4'} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent sideOffset={8}>
                  {isTTSPlaying ? t('planView.tts.stopSpeaking') : t('planView.tts.readAloud')}
                </TooltipContent>
              </Tooltip>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                const result = await copyTextToClipboard(content);
                if (result.ok) {
                  setCopiedContent(true);
                  if (copiedContentTimeoutRef.current !== null) {
                    window.clearTimeout(copiedContentTimeoutRef.current);
                  }
                  copiedContentTimeoutRef.current = window.setTimeout(() => {
                    setCopiedContent(false);
                  }, 1200);
                } else {
                  // ignored
                }
              }}
              className="h-5 w-5 p-0"
              title={t('planView.actions.copyPlanContents')}
              aria-label={t('planView.actions.copyPlanContents')}
            >
              {copiedContent ? (
                <Icon name="check" className="h-4 w-4 text-[color:var(--status-success)]" />
              ) : (
                <Icon name="clipboard" className="h-4 w-4" />
              )}
            </Button>
          </div>
        ) : null}
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
                {mdViewMode === 'preview' ? (
                  <div className="h-full overflow-auto p-3" ref={setPreviewContainer}>
                    {/* Same comment-on-selection as a markdown file preview. */}
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
                      <SimpleMarkdownRenderer content={content} documentAssets={markdownDocumentAssets} className="typography-markdown-body" frontmatter="properties" enableFileReferences={false} />
                    </ErrorBoundary>
                  </div>
                ) : (
                  <div className="relative h-full" ref={editorWrapperRef}>
                    <CodeMirrorEditor
                      value={content}
                      onChange={handleContentChange}
                      readOnly={false}
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
    </div>
  );
};
