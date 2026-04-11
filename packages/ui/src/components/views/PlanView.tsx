import React from 'react';
import { CodeMirrorEditor } from '@/components/ui/CodeMirrorEditor';
import { PreviewToggleButton } from './PreviewToggleButton';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Button } from '@/components/ui/button';
import { buildCodeMirrorCommentWidgets, normalizeLineRange, useInlineCommentController } from '@/components/comments';

import { getLanguageFromExtension } from '@/lib/toolHelpers';
import { useDeviceInfo } from '@/lib/device';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { generateSyntaxTheme } from '@/lib/theme/syntaxThemeGenerator';
import { createFlexokiCodeMirrorTheme } from '@/lib/codemirror/flexokiTheme';
import { languageByExtension } from '@/lib/codemirror/languageByExtension';
import { RiCheckLine, RiClipboardLine, RiFileCopy2Line } from '@remixicon/react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessions } from '@/sync/sync-context';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { EditorView } from '@codemirror/view';
import { copyTextToClipboard } from '@/lib/clipboard';

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

type SelectedLineRange = {
  start: number;
  end: number;
};

export const PlanView: React.FC = () => {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const sessions = useSessions();
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const planModeEnabled = useFeatureFlagsStore((state) => state.planModeEnabled);
  const runtimeApis = useRuntimeAPIs();
  const { isMobile } = useDeviceInfo();
  const { currentTheme } = useThemeSystem();
  React.useMemo(() => generateSyntaxTheme(currentTheme), [currentTheme]);

  const session = React.useMemo(() => {
    if (!currentSessionId) return null;
    return sessions.find((s) => s.id === currentSessionId) ?? null;
  }, [currentSessionId, sessions]);

  const sessionDirectory = React.useMemo(() => {
    const raw = typeof session?.directory === 'string' ? session.directory : '';
    return normalize(raw || '');
  }, [session?.directory]);

  const [resolvedPath, setResolvedPath] = React.useState<string | null>(null);
  const displayPath = React.useMemo(() => {
    if (!resolvedPath || !sessionDirectory || !homeDirectory) {
      return resolvedPath;
    }
    return toDisplayPath(resolvedPath, { currentDirectory: sessionDirectory, homeDirectory });
  }, [resolvedPath, sessionDirectory, homeDirectory]);
  const [content, setContent] = React.useState<string>('');
  const planFileLabel = React.useMemo(() => {
    return displayPath ? displayPath.split('/').pop() || 'plan' : 'plan';
  }, [displayPath]);
  const [loading, setLoading] = React.useState(false);
  const [copiedPath, setCopiedPath] = React.useState(false);
  const [copiedContent, setCopiedContent] = React.useState(false);
  const [mdViewMode, setMdViewMode] = React.useState<'preview' | 'edit'>('edit');
  const copiedTimeoutRef = React.useRef<number | null>(null);
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

      setLineSelection(null);
      cancel();
    };

    const timeoutId = window.setTimeout(() => {
      document.addEventListener('click', handleClickOutside);
    }, 100);

    return () => {
      window.clearTimeout(timeoutId);
      document.removeEventListener('click', handleClickOutside);
    };
  }, [cancel, editingDraftId, isMobile, lineSelection]);


  const editorExtensions = React.useMemo(() => {
    const extensions = [createFlexokiCodeMirrorTheme(currentTheme)];
    const language = languageByExtension(resolvedPath || 'plan.md');
    if (language) {
      extensions.push(language);
    }
    extensions.push(EditorView.lineWrapping);
    return extensions;
  }, [currentTheme, resolvedPath]);

  React.useEffect(() => {
    // Early exit if plan mode is disabled - don't load anything
    if (!planModeEnabled) {
      setResolvedPath(null);
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

      const response = await fetch(`/api/fs/read?path=${encodeURIComponent(path)}`);
      if (!response.ok) {
        throw new Error(`Failed to read plan file (${response.status})`);
      }
      return response.text();
    };

    const run = async () => {
      setResolvedPath(null);
      setContent('');

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
        let text: string | null = null;

        try {
          text = await readText(repoPath);
          resolved = repoPath;
        } catch {
          // ignore
        }

        if (!resolved) {
          try {
            text = await readText(homePath);
            resolved = homePath;
          } catch {
            // ignore
          }
        }

        if (cancelled) return;

        if (!resolved || text === null) {
          setResolvedPath(null);
          setContent('');
          return;
        }

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
  }, [planModeEnabled, sessionDirectory, session?.slug, session?.time?.created, homeDirectory, runtimeApis.files]);

  React.useEffect(() => {
    return () => {
      if (copiedTimeoutRef.current !== null) {
        window.clearTimeout(copiedTimeoutRef.current);
      }
      if (copiedContentTimeoutRef.current !== null) {
        window.clearTimeout(copiedContentTimeoutRef.current);
      }
    };
  }, []);

  const blockWidgets = React.useMemo(() => {
    return buildCodeMirrorCommentWidgets({
      drafts: planFileDrafts,
      editingDraftId,
      commentText,
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
  }, [commentText, deleteDraft, editingDraftId, handleCancelComment, handleSaveComment, isDragging, lineSelection, planFileDrafts, planFileLabel, startEdit]);

  return (
    <div className="relative flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden bg-background">
      <div className="flex min-w-0 items-center gap-2 border-b border-border/40 px-3 py-1.5 flex-shrink-0">
        <div className="min-w-0 flex-1">
          <div className="typography-ui-label font-medium truncate">Plan</div>
          {resolvedPath ? (
            <div className="typography-meta text-muted-foreground truncate" title={displayPath ?? resolvedPath}>
              {displayPath ?? resolvedPath}
            </div>
          ) : null}
        </div>
        {resolvedPath ? (
          <div className="flex items-center gap-1">
            <PreviewToggleButton
              currentMode={mdViewMode}
              onToggle={() => saveMdViewMode(mdViewMode === 'preview' ? 'edit' : 'preview')}
            />
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
              title="Copy plan contents"
              aria-label="Copy plan contents"
            >
              {copiedContent ? (
                <RiCheckLine className="h-4 w-4 text-[color:var(--status-success)]" />
              ) : (
                <RiClipboardLine className="h-4 w-4" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                const result = await copyTextToClipboard(displayPath ?? resolvedPath);
                if (result.ok) {
                  setCopiedPath(true);
                  if (copiedTimeoutRef.current !== null) {
                    window.clearTimeout(copiedTimeoutRef.current);
                  }
                  copiedTimeoutRef.current = window.setTimeout(() => {
                    setCopiedPath(false);
                  }, 1200);
                } else {
                  // ignored
                }
              }}
              className="h-5 w-5 p-0"
              title={`Copy plan path (${displayPath ?? resolvedPath})`}
              aria-label={`Copy plan path (${displayPath ?? resolvedPath})`}
            >
              {copiedPath ? (
                <RiCheckLine className="h-4 w-4 text-[color:var(--status-success)]" />
              ) : (
                <RiFileCopy2Line className="h-4 w-4" />
              )}
            </Button>
          </div>
        ) : null}
      </div>

      <div className="flex-1 min-h-0 min-w-0 relative">
        <ScrollableOverlay outerClassName="h-full min-w-0" className="h-full min-w-0">
          {loading ? (
            <div className="p-3 typography-ui text-muted-foreground">Loading…</div>
          ) : (
            <div className="relative h-full">
              <div className="h-full oc-plan-editor">
                {mdViewMode === 'preview' ? (
                  <div className="h-full overflow-auto p-3">
                    <ErrorBoundary
                      fallback={
                        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
                          <div className="mb-1 font-medium text-destructive">Preview unavailable</div>
                          <div className="text-sm text-muted-foreground">
                            Switch to edit mode to fix the issue.
                          </div>
                        </div>
                      }
                    >
                      <SimpleMarkdownRenderer content={content} className="typography-markdown-body" />
                    </ErrorBoundary>
                  </div>
                ) : (
                  <div className="relative h-full" ref={editorWrapperRef}>
                    <CodeMirrorEditor
                      value={content}
                      onChange={() => {
                        // read-only
                      }}
                      readOnly={true}
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
