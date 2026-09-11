import React from 'react';
import { runtimeFetch } from '@/lib/runtime-fetch';
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
import { buildCodeMirrorCommentWidgets, normalizeLineRange, useInlineCommentController } from '@/components/comments';

import { getLanguageFromExtension } from '@/lib/toolHelpers';
import { useDeviceInfo } from '@/lib/device';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { createFlexokiCodeMirrorTheme } from '@/lib/codemirror/flexokiTheme';
import { shikiHighlightExtension } from '@/lib/codemirror/shikiHighlight';
import { getResolvedShikiTheme } from '@/lib/shiki/appThemeRegistry';
import { languageByExtension } from '@/lib/codemirror/languageByExtension';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessions } from '@/sync/sync-context';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSelectionStore } from '@/sync/selection-store';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionGoalArmStore } from '@/stores/useSessionGoalArmStore';
import { useUIStore } from '@/stores/useUIStore';
import { useGitStore } from '@/stores/useGitStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { EditorView } from '@codemirror/view';
import { copyTextToClipboard } from '@/lib/clipboard';
import { generateBranchName } from '@/lib/git/branchNameGenerator';
import { fetchProjectPlan, parsePlanMarkdown, resolveProjectContextId, type SavedProjectPlanTarget } from '@/lib/projectContextApi';
import { CHAT_DRAFT_PROJECT_ID } from '@/lib/chatDirectories';
import { createPlanSaveQueue } from '@/lib/planSaveQueue';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useProjectContextStore } from '@/stores/useProjectContextStore';
import { createWorktreeSessionForNewBranch } from '@/lib/worktreeSessionCreator';
import { TodoSendDialog, type TodoSendExecution } from '@/components/session/TodoSendDialog';
import { Icon } from "@/components/icon/Icon";
import { useMessageTTS } from '@/hooks/useMessageTTS';
import { renderMagicPrompt } from '@/lib/magicPrompts';
import { useI18n } from '@/lib/i18n';

type PlanViewProps = {
  targetPath?: string | null;
  /** Saved project plan to open, with the project that owns it. The owner is
      part of the prop so the view never guesses it from the current directory:
      plan tabs outlive directory changes (persisted context tabs, mobile
      overlays), and for managed chats the owner is not a registered project a
      directory lookup could ever find. */
  savedProjectPlan?: SavedProjectPlanTarget | null;
  /** Called after a send action routes the user to the chat — hosts that show
      PlanView in an overlay (mobile fullscreen surface) close it here. */
  onNavigatedToChat?: () => void;
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

const joinPath = (base: string, segment: string): string => {
  const normalizedBase = normalize(base);
  const cleanSegment = segment.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalizedBase || normalizedBase === '/') {
    return `/${cleanSegment}`;
  }
  return `${normalizedBase}/${cleanSegment}`;
};

const buildRepoPlanPath = (directory: string, created: number, slug: string): string => {
  return joinPath(joinPath(joinPath(directory, '.opencode'), 'plans'), `${created}-${slug}.md`);
};

const buildHomePlanPath = (created: number, slug: string): string => {
  return `~/.opencode/plans/${created}-${slug}.md`;
};

const resolveTilde = (path: string, homeDir: string | null): string => {
  const trimmed = path.trim();
  if (!trimmed.startsWith('~')) return trimmed;
  if (trimmed === '~') return homeDir || trimmed;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return homeDir ? `${homeDir}${trimmed.slice(1)}` : trimmed;
  }
  return trimmed;
};

const toDisplayPath = (resolvedPath: string, options: { currentDirectory: string; homeDirectory: string }): string => {
  const current = normalize(options.currentDirectory);
  const home = normalize(options.homeDirectory);
  const normalized = normalize(resolvedPath);

  if (current && normalized.startsWith(current + '/')) {
    return normalized.slice(current.length + 1);
  }

  if (home && normalized === home) {
    return '~';
  }

  if (home && normalized.startsWith(home + '/')) {
    return `~${normalized.slice(home.length)}`;
  }

  return normalized;
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

const subscribeActiveRuntimeKey = (onStoreChange: () => void): (() => void) => {
  return subscribeRuntimeEndpointChanged(() => onStoreChange());
};

type SelectedLineRange = {
  start: number;
  end: number;
};

export const PlanView: React.FC<PlanViewProps> = ({ targetPath = null, savedProjectPlan = null, onNavigatedToChat }) => {
  const { t } = useI18n();
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const createSession = useSessionUIStore((state) => state.createSession);
  const initializeNewOpenChamberSession = useSessionUIStore((state) => state.initializeNewOpenChamberSession);
  const sendMessage = useSessionUIStore((state) => state.sendMessage);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const sessions = useSessions();
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const planModeEnabled = useFeatureFlagsStore((state) => state.planModeEnabled);
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const gitDirectories = useGitStore((state) => state.directories);
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const setSessionSwitcherOpen = useUIStore((state) => state.setSessionSwitcherOpen);
  const runtimeApis = useRuntimeAPIs();
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

  const [resolvedPath, setResolvedPath] = React.useState<string | null>(null);
  // Set once a saved project plan has actually loaded. Kept separate from
  // `resolvedPath` so nothing downstream can mistake a project plan for a file
  // the user could open, edit, or be shown a path for.
  const [loadedProjectPlanId, setLoadedProjectPlanId] = React.useState<string | null>(null);
  const hasDocument = Boolean(resolvedPath) || Boolean(loadedProjectPlanId);
  const displayPath = React.useMemo(() => {
    if (!resolvedPath || !sessionDirectory || !homeDirectory) {
      return resolvedPath;
    }
    return toDisplayPath(resolvedPath, { currentDirectory: sessionDirectory, homeDirectory });
  }, [resolvedPath, sessionDirectory, homeDirectory]);
  const [content, setContent] = React.useState<string>('');
  const { isPlaying: isTTSPlaying, play: playTTS, stop: stopTTS } = useMessageTTS();
  const showMessageTTSButtons = useConfigStore((state) => state.showMessageTTSButtons);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const planFileLabel = React.useMemo(() => {
    return displayPath ? displayPath.split('/').pop() || t('planView.file.defaultName') : t('planView.file.defaultName');
  }, [displayPath, t]);
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
  const isSelectingRef = React.useRef(false);
  const selectionStartRef = React.useRef<number | null>(null);
  const [isDragging, setIsDragging] = React.useState(false);

  React.useEffect(() => {
    const handleGlobalMouseUp = () => {
      isSelectingRef.current = false;
      selectionStartRef.current = null;
      setIsDragging(false);
    };
    document.addEventListener('mouseup', handleGlobalMouseUp);
    return () => document.removeEventListener('mouseup', handleGlobalMouseUp);
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
    fileLabel: planFileLabel,
    language: resolvedPath ? getLanguageFromExtension(resolvedPath) || 'markdown' : 'markdown',
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
  }, [cancel, commentText, editingDraftId, isMobile, lineSelection]);

  const editorFontSize = useUIStore((state) => state.editorFontSize);

  const editorExtensions = React.useMemo(() => {
    // Shiki token colors only for code files; markdown keeps the lezer
    // highlighter (markdown-aware bold headings etc., and no Shiki view to match).
    const shikiLanguage = resolvedPath ? getLanguageFromExtension(resolvedPath) : null;
    const useShiki = Boolean(shikiLanguage) && shikiLanguage !== 'markdown';
    const extensions = [createFlexokiCodeMirrorTheme(currentTheme, useShiki ? { syntaxColors: false, fontSize: editorFontSize } : { fontSize: editorFontSize })];
    const language = languageByExtension(resolvedPath || 'plan.md');
    if (language) {
      extensions.push(language);
    }
    if (useShiki && shikiLanguage) {
      extensions.push(shikiHighlightExtension({
        language: shikiLanguage,
        themeName: currentTheme.metadata.id,
        theme: getResolvedShikiTheme(currentTheme),
      }));
    }
    extensions.push(EditorView.lineWrapping);
    return extensions;
  }, [currentTheme, resolvedPath, editorFontSize]);

  // Pending-save bookkeeping for the open document. One ref record, not state:
  // debounced writes and close-time flushes must read the newest buffer and
  // revision without another render. `editRevision` advances on every editor
  // change; `savedRevision` only after a successful write of that exact
  // revision, so a slow in-flight save can never mark newer edits as saved.
  // `key` and `runtimeKey` make every write self-identifying: content never
  // crosses documents or runtimes, no matter when a queued write settles.
  const docRef = React.useRef<{
    key: string | null;
    target: SavedProjectPlanTarget | { filePath: string } | null;
    content: string;
    editRevision: number;
    savedRevision: number;
    runtimeKey: string;
  }>({ key: null, target: null, content: '', editRevision: 0, savedRevision: 0, runtimeKey: '' });
  const saveQueue = React.useState(createPlanSaveQueue)[0];

  // Filesystem writes keep the runtime adapter precedence the view always
  // used: the active RuntimeAPIs first, the registry as fallback.
  const writeDocument = React.useCallback(async (target: NonNullable<typeof docRef.current['target']>, text: string): Promise<void> => {
    if ('filePath' in target) {
      const files = runtimeApis.files ?? getRegisteredRuntimeAPIs()?.files;
      if (files?.writeFile) {
        const result = await files.writeFile(target.filePath, text);
        if (!result?.success) {
          throw new Error('Plan file write failed');
        }
        return;
      }
      const response = await runtimeFetch('/api/fs/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: target.filePath, content: text }),
      });
      if (!response.ok) {
        throw new Error(`Failed to write plan file (${response.status})`);
      }
      return;
    }
    const saved = await useProjectContextStore.getState().savePlan(target.projectRef, target.planId, text);
    if (!saved) {
      throw new Error('Plan save rejected: the plan no longer exists');
    }
  }, [runtimeApis.files]);
  const writeDocumentRef = React.useRef(writeDocument);
  writeDocumentRef.current = writeDocument;

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
      write: writeDocumentRef.current,
    };
    saveQueue.schedule(captured.key, captured.revision, async () => {
      if (getRuntimeKey() !== captured.runtimeKey) {
        // The runtime switched while this write waited: writing through the
        // new connection would land one host's edits on another.
        return;
      }
      await captured.write(captured.target, captured.content);
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
    // Saved project plans opened via context panel should work even when session plan mode is off.
    if (!planModeEnabled && !targetPath && !savedPlanId) {
      scheduleSave();
      docRef.current = { key: null, target: null, content: '', editRevision: 0, savedRevision: 0, runtimeKey: '' };
      setResolvedPath(null);
      setLoadedProjectPlanId(null);
      setContent('');
      setLoading(false);
      return;
    }

    let cancelled = false;

    const readText = async (path: string): Promise<string> => {
      if (runtimeApis.files?.readFile) {
        const result = await runtimeApis.files.readFile(path);
        return result?.content ?? '';
      }

      const runtimeFiles = getRegisteredRuntimeAPIs()?.files;
      if (runtimeFiles?.readFile) {
        const result = await runtimeFiles.readFile(path, { optional: true });
        return result?.content ?? '';
      }

      const response = await runtimeFetch(`/api/fs/read?path=${encodeURIComponent(path)}&optional=true`, {
        // Avoid conditional requests (304 + empty body).
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error(`Failed to read plan file (${response.status})`);
      }
      return response.text();
    };

    const run = async () => {
      // Flush the outgoing document before the bookkeeping is replaced, so
      // edits typed within the debounce window survive a plan switch. React
      // reuses this component instance across saved-plan tabs.
      scheduleSave();
      docRef.current = { key: null, target: null, content: '', editRevision: 0, savedRevision: 0, runtimeKey: '' };
      setResolvedPath(null);
      setLoadedProjectPlanId(null);
      setContent('');
      setSaveError(null);
      setLoadError(null);

      if (savedPlanId && savedPlanProjectRef && savedPlanKey) {
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
        } catch (error) {
          if (cancelled) return;
          setLoadError(error instanceof Error ? error.message : 'Plan load failed');
        } finally {
          if (!cancelled) setLoading(false);
        }
        return;
      }

      if (targetPath) {
        const fileKey = JSON.stringify(['plan-file', activeRuntimeKey, targetPath]);
        await saveQueue.pendingFor(fileKey);
        if (cancelled) return;
        saveQueue.reset(fileKey);
        setLoading(true);
        try {
          const text = await readText(targetPath);
          if (cancelled) return;
          docRef.current = {
            key: fileKey,
            target: { filePath: targetPath },
            content: text,
            editRevision: 0,
            savedRevision: 0,
            runtimeKey: activeRuntimeKey,
          };
          setResolvedPath(targetPath);
          setContent(text);
        } catch {
          if (cancelled) return;
          setResolvedPath(null);
          setContent('');
        } finally {
          if (!cancelled) setLoading(false);
        }
        return;
      }

      if (!session?.slug || !session?.time?.created || !sessionDirectory) {
        setResolvedPath(null);
        setContent('');
        return;
      }

      setLoading(true);

      try {
        const repoPath = buildRepoPlanPath(sessionDirectory, session.time.created, session.slug);
        const homePath = resolveTilde(buildHomePlanPath(session.time.created, session.slug), homeDirectory || null);

        let resolved: string | null = null;

        try {
          await readText(repoPath);
          resolved = repoPath;
        } catch {
          // ignore
        }

        if (!resolved) {
          try {
            await readText(homePath);
            resolved = homePath;
          } catch {
            // ignore
          }
        }

        if (cancelled) return;

        if (!resolved) {
          setResolvedPath(null);
          setContent('');
          return;
        }

        const sessionFileKey = JSON.stringify(['plan-file', activeRuntimeKey, resolved]);
        await saveQueue.pendingFor(sessionFileKey);
        if (cancelled) return;
        const text = await readText(resolved);
        if (cancelled) return;
        saveQueue.reset(sessionFileKey);
        docRef.current = {
          key: sessionFileKey,
          target: { filePath: resolved },
          content: text,
          editRevision: 0,
          savedRevision: 0,
          runtimeKey: activeRuntimeKey,
        };
        setResolvedPath(resolved);
        setContent(text);
      } catch {
        if (cancelled) return;
        setResolvedPath(null);
        setContent('');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [activeRuntimeKey, homeDirectory, planModeEnabled, runtimeApis.files, savedPlanId, savedPlanKey, savedPlanProjectRef, saveQueue, scheduleSave, session?.slug, session?.time?.created, sessionDirectory, targetPath]);

  // Synchronous buffer tracking: if an edit and an unmount land in the same
  // batch, the passive content effect would never run and a flush would save
  // a stale buffer.
  const handleContentChange = React.useCallback((next: string) => {
    docRef.current.content = next;
    docRef.current.editRevision += 1;
    setContent(next);
  }, []);

  // The debounced write and the close/switch flush go through the same queue
  // (scheduleSave), so two saves of one document can never complete out of
  // order and a flush never duplicates a debounce of the same revision.
  React.useEffect(() => {
    if (!resolvedPath && !loadedProjectPlanId) {
      return;
    }

    const controller = window.setTimeout(() => {
      scheduleSave();
    }, 350);

    return () => {
      window.clearTimeout(controller);
    };
  }, [content, loadedProjectPlanId, resolvedPath, scheduleSave]);

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
      // For filesystem plans those are the same directory.
      const sendTargetProject = savedPlanProjectRef ?? currentProjectRef;
      if (!sendTargetProject || !pendingPlanSend || isManagedChatPlan) {
        return;
      }

      const visiblePrompt = await renderMagicPrompt(
        pendingPlanSend.action === 'improve' ? 'plan.improve.visible' : 'plan.implement.visible',
        {
          plan_title: sendPromptTitle,
        },
      );
      const instructionsText = await renderMagicPrompt(
        pendingPlanSend.action === 'improve' ? 'plan.improve.instructions' : 'plan.implement.instructions',
        {
          plan_title: sendPromptTitle,
          plan_path: resolvedPath ?? '',
        },
      );
      // Saved project plans have no file path for the agent to read. Without
      // this the instructions say "read that file" with an empty path and the
      // plan contents never reach the session, so the plan substance rides
      // along in the synthetic message instead.
      const planSubstance = resolvedPath
        ? instructionsText
        : [
            instructionsText,
            '',
            'The plan is not stored as a file in the repository and has no file path. Its full current contents follow below this note and are the source of truth for the plan. Where the instructions above refer to the plan file, treat the plan as stored in OpenChamber project knowledge (it is edited through the OpenChamber UI): propose plan revisions as plan text in the chat rather than editing a file.',
            '',
            content,
          ].join('\n');
      const syntheticParts = [{ synthetic: true as const, text: planSubstance }];
      setIsPlanSendSubmitting(true);

      try {
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
          directoryHint = created.path;
        } else {
          const sessionResult = await createSession(undefined, sendTargetProject.path, null);
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
        const goalObjective = execution.runAsGoal === true
          ? [
              `Implement the plan "${sendPromptTitle}" end-to-end${resolvedPath ? ` (plan file: ${resolvedPath})` : ' (the full plan follows)'}.`,
              resolvedPath
                ? 'Re-read that file for full details — it is the source of truth.'
                : 'The full plan follows in this message and is the source of truth.',
              '',
              content,
            ].join('\n')
          : null;
        useSessionGoalArmStore.getState().setArmed(execution.runAsGoal === true, goalObjective);
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
    [canCreateWorktree, content, createSession, currentProjectRef, initializeNewOpenChamberSession, isManagedChatPlan, pendingPlanSend, resolvedPath, routeToChat, savedPlanProjectRef, sendMessage, sendPromptTitle, setCurrentSession]
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
      <div className="flex min-w-0 items-center gap-2 border-b border-border/40 px-3 py-1.5 flex-shrink-0">
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
                    {isTTSPlaying ? (
                      <Icon name="stop" className="h-4 w-4 text-[color:var(--status-success)]" />
                    ) : (
                      <Icon name="volume-up" className="h-4 w-4" />
                    )}
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
        allowRunAsGoal
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
                  <div className="h-full overflow-auto p-3">
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
                      <SimpleMarkdownRenderer content={content} className="typography-markdown-body" enableFileReferences={false} />
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
                      lineNumbersConfig={{
                        domEventHandlers: {
                          mousedown: (view, line, event) => {
                            if (!(event instanceof MouseEvent)) return false;
                            if (event.button !== 0) return false;
                            event.preventDefault();
                            const lineNumber = view.state.doc.lineAt(line.from).number;

                            if (
                              lineSelection &&
                              !event.shiftKey &&
                              Math.min(lineSelection.start, lineSelection.end) === lineNumber &&
                              Math.max(lineSelection.start, lineSelection.end) === lineNumber
                            ) {
                              setLineSelection(null);
                              cancel();
                              isSelectingRef.current = false;
                              selectionStartRef.current = null;
                              setIsDragging(false);
                              return true;
                            }

                            if (isMobile && lineSelection && !event.shiftKey) {
                              const start = Math.min(lineSelection.start, lineSelection.end, lineNumber);
                              const end = Math.max(lineSelection.start, lineSelection.end, lineNumber);
                              setLineSelection({ start, end });
                              isSelectingRef.current = false;
                              selectionStartRef.current = null;
                              setIsDragging(false);
                              return true;
                            }

                            isSelectingRef.current = true;
                            selectionStartRef.current = lineNumber;
                            setIsDragging(true);

                            if (lineSelection && event.shiftKey) {
                              const start = Math.min(lineSelection.start, lineNumber);
                              const end = Math.max(lineSelection.end, lineNumber);
                              setLineSelection({ start, end });
                            } else {
                              setLineSelection({ start: lineNumber, end: lineNumber });
                            }

                            return true;
                          },
                          mouseover: (view, line, event) => {
                            if (!(event instanceof MouseEvent)) return false;
                            if (event.buttons !== 1) return false;
                            if (!isSelectingRef.current || selectionStartRef.current === null) return false;
                            const lineNumber = view.state.doc.lineAt(line.from).number;
                            const start = Math.min(selectionStartRef.current, lineNumber);
                            const end = Math.max(selectionStartRef.current, lineNumber);
                            setLineSelection({ start, end });
                            setIsDragging(true);
                            return false;
                          },
                          mouseup: () => {
                            isSelectingRef.current = false;
                            selectionStartRef.current = null;
                            setIsDragging(false);
                            return false;
                          },
                        },
                    }}
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
