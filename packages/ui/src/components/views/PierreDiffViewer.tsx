import React, { useMemo, useRef, useCallback, useEffect } from 'react';
import {
  FileDiff as PierreFileDiff,
  VirtualizedFileDiff,
  Virtualizer,
  type FileContents,
  type FileDiffOptions,
  type DiffLineAnnotation,
  type SelectedLineRange,
  type AnnotationSide,
  type VirtualFileMetrics,
} from '@pierre/diffs';
import {
  buildPierreLineAnnotations,
  type PierreAnnotationData,
  PierreDiffCommentOverlays,
  toPierreAnnotationId,
  useInlineCommentController,
} from '@/components/comments';

import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useWorkerPool } from '@/contexts/DiffWorkerProvider';
import { ensurePierreThemeRegistered, getResolvedShikiTheme } from '@/lib/shiki/appThemeRegistry';
import { getDefaultTheme } from '@/lib/theme/themes';

import { useUIStore } from '@/stores/useUIStore';
import { useDeviceInfo } from '@/lib/device';
import { cn } from '@/lib/utils';


interface PierreDiffViewerProps {
  original: string;
  modified: string;
  language: string;
  fileName?: string;
  renderSideBySide: boolean;
  wrapLines?: boolean;
  layout?: 'fill' | 'inline';
}

// CSS injected into Pierre's Shadow DOM for WebKit scroll optimization
// Note: avoid will-change and contain:paint as they break resize behavior
const WEBKIT_SCROLL_FIX_CSS = `
  :host {
    font-family: var(--font-mono);
    font-size: var(--text-code);
  }

  pre, [data-code] {
    font-family: var(--font-mono);
    font-size: var(--text-code);
  }

  /* Mobile touch selection support */
  [data-line-number] {
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
    cursor: pointer;
  }

  /* Ensure interactive line numbers work on touch */
  pre[data-interactive-line-numbers] [data-line-number] {
    touch-action: manipulation;
  }

  [data-diff-header],
  [data-diff] {
    [data-separator] {
      height: 24px !important;
    }
  }
  `;

// Fast cache key - use length + samples instead of full hash
function fnv1a32(input: string): string {
  // Fast + stable across runtimes; good enough for cache keys.
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // hash *= 16777619 (but keep 32-bit)
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16);
}

function makeContentCacheKey(contents: string): string {
  // Avoid hashing full file; sample head+tail.
  const sample = contents.length > 400
    ? `${contents.slice(0, 200)}${contents.slice(-200)}`
    : contents;
  return `${contents.length}:${fnv1a32(sample)}`;
}

const extractSelectedCode = (original: string, modified: string, range: SelectedLineRange): string => {
  // Default to modified if side is ambiguous, as users mostly comment on new code
  const isOriginal = range.side === 'deletions';
  const content = isOriginal ? original : modified;
  const lines = content.split('\n');

  // Ensure bounds
  const from = Math.min(range.start, range.end);
  const to = Math.max(range.start, range.end);
  const startLine = Math.max(1, from);
  const endLine = Math.min(lines.length, to);

  if (startLine > endLine) return '';

  return lines.slice(startLine - 1, endLine).join('\n');
};

const isSameSelection = (left: SelectedLineRange | null, right: SelectedLineRange | null): boolean => {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.start === right.start && left.end === right.end && left.side === right.side;
};

type SharedVirtualizer = {
  virtualizer: Virtualizer;
  release: () => void;
};

type VirtualizerTarget = {
  key: Document | HTMLElement;
  root: Document | HTMLElement;
  content: HTMLElement | undefined;
};

type VirtualizerEntry = {
  virtualizer: Virtualizer;
  refs: number;
};

const virtualizerCache = new WeakMap<Document | HTMLElement, VirtualizerEntry>();

const VIRTUAL_METRICS: Partial<VirtualFileMetrics> = {
  lineHeight: 24,
  hunkSeparatorHeight: 24,
  fileGap: 0,
};

function resolveVirtualizerTarget(container: HTMLElement): VirtualizerTarget {
  const root = container.closest('[data-diff-virtual-root]');
  if (root instanceof HTMLElement) {
    const content = root.querySelector('[data-diff-virtual-content]');
    return {
      key: root,
      root,
      content: content instanceof HTMLElement ? content : undefined,
    };
  }

  return {
    key: document,
    root: document,
    content: undefined,
  };
}

function acquireSharedVirtualizer(container: HTMLElement): SharedVirtualizer | null {
  if (typeof document === 'undefined') return null;

  const target = resolveVirtualizerTarget(container);
  let entry = virtualizerCache.get(target.key);

  if (!entry) {
    const virtualizer = new Virtualizer();
    virtualizer.setup(target.root, target.content);
    entry = { virtualizer, refs: 0 };
    virtualizerCache.set(target.key, entry);
  }

  entry.refs += 1;
  let released = false;

  return {
    virtualizer: entry.virtualizer,
    release: () => {
      if (released) return;
      released = true;

      const current = virtualizerCache.get(target.key);
      if (!current) return;

      current.refs -= 1;
      if (current.refs > 0) return;

      current.virtualizer.cleanUp();
      virtualizerCache.delete(target.key);
    },
  };
}

export const PierreDiffViewer: React.FC<PierreDiffViewerProps> = ({
  original,
  modified,
  language,
  fileName,
  renderSideBySide,
  wrapLines,
  layout = 'fill',
}) => {
  const themeContext = useOptionalThemeSystem();

  const isDark = themeContext?.currentTheme.metadata.variant === 'dark';
  const lightTheme = themeContext?.availableThemes.find(t => t.metadata.id === themeContext.lightThemeId) ?? getDefaultTheme(false);
  const darkTheme = themeContext?.availableThemes.find(t => t.metadata.id === themeContext.darkThemeId) ?? getDefaultTheme(true);

  useUIStore();
  const { isMobile } = useDeviceInfo();

  const diffCommentController = useInlineCommentController<SelectedLineRange>({
    source: 'diff',
    fileLabel: fileName || 'unknown',
    language,
    getCodeForRange: (range) => extractSelectedCode(original, modified, range),
    toStoreRange: (range) => ({
      startLine: range.start,
      endLine: range.end,
      side: range.side === 'deletions' ? 'original' : 'modified',
    }),
    fromDraftRange: (draft) => ({
      start: draft.startLine,
      end: draft.endLine,
      side: draft.side === 'original' ? 'deletions' : 'additions',
    }),
  });

  const {
    drafts: fileDrafts,
    selection,
    setSelection,
    commentText,
    setCommentText,
    editingDraftId,
    saveComment,
    cancel,
    startEdit,
    deleteDraft,
  } = diffCommentController;

  const selectionRef = useRef<SelectedLineRange | null>(null);
  const editingDraftIdRef = useRef<string | null>(null);
  // Use a ref to track if we're currently applying a selection programmatically
  // to avoid loop with onLineSelected callback
  const isApplyingSelectionRef = useRef(false);
  const lastAppliedSelectionRef = useRef<SelectedLineRange | null>(null);

  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  useEffect(() => {
    editingDraftIdRef.current = editingDraftId;
  }, [editingDraftId]);

  const handleSelectionChange = useCallback((range: SelectedLineRange | null) => {
    // Ignore callbacks while we're programmatically applying selection
    if (isApplyingSelectionRef.current) {
      return;
    }

    const prevSelection = selectionRef.current;

    // Mobile tap-to-extend: if selection exists and new tap is on same side, extend range
    if (isMobile && prevSelection && range && range.side === prevSelection.side) {
      const start = Math.min(prevSelection.start, range.start);
      const end = Math.max(prevSelection.end, range.end);
      setSelection({ ...range, start, end });
    } else {
      setSelection(range);
    }

    // Clear editing state when selection changes user-driven
    if (range) {
      if (!editingDraftIdRef.current) {
        setCommentText('');
      }
    }
  }, [isMobile, setCommentText, setSelection]);

  const handleCancelComment = useCallback(() => {
    cancel();
  }, [cancel]);

  const renderAnnotation = useCallback((annotation: DiffLineAnnotation<PierreAnnotationData>) => {
    const div = document.createElement('div');
    div.style.position = 'relative';

    const id = toPierreAnnotationId(annotation.metadata);

    div.dataset.annotationId = id;
    div.dataset.annotationSide = annotation.side;
    div.dataset.annotationLine = String(annotation.lineNumber);
    return div;
  }, []);

  const handleSaveComment = useCallback((textToSave: string, rangeOverride?: SelectedLineRange) => {
    saveComment(textToSave, rangeOverride ?? selection ?? undefined);
  }, [saveComment, selection]);


  const applySelection = useCallback((range: SelectedLineRange) => {
    setSelection(range);
    const instance = diffInstanceRef.current;
    if (!instance) return;
    try {
      isApplyingSelectionRef.current = true;
      instance.setSelectedLines(range);
      lastAppliedSelectionRef.current = range;
    } catch {
      // ignore
    } finally {
      isApplyingSelectionRef.current = false;
    }
  }, [setSelection]);

  const resolveClickedSide = useCallback((numberCell: HTMLElement): AnnotationSide => {
    const lineType =
      numberCell.closest('[data-line-type]')?.getAttribute('data-line-type')
      ?? numberCell.getAttribute('data-line-type');
    if (lineType === 'change-deletion') {
      return 'deletions';
    }
    if (lineType === 'change-addition') {
      return 'additions';
    }

    const explicitColumnSide =
      numberCell.getAttribute('data-column-side')
      ?? numberCell.getAttribute('data-side')
      ?? numberCell.closest('[data-column-side]')?.getAttribute('data-column-side');
    if (explicitColumnSide === 'deletions' || explicitColumnSide === 'left' || explicitColumnSide === 'original') {
      return 'deletions';
    }
    if (explicitColumnSide === 'additions' || explicitColumnSide === 'right' || explicitColumnSide === 'modified') {
      return 'additions';
    }

    const row = numberCell.closest('[data-line-type]');
    if (row instanceof HTMLElement) {
      const rowRect = row.getBoundingClientRect();
      const cellRect = numberCell.getBoundingClientRect();
      const rowCenter = rowRect.left + rowRect.width / 2;
      const cellCenter = cellRect.left + cellRect.width / 2;
      return cellCenter < rowCenter ? 'deletions' : 'additions';
    }

    return 'additions';
  }, []);

  ensurePierreThemeRegistered(lightTheme);
  ensurePierreThemeRegistered(darkTheme);

  const diffThemeKey = `${lightTheme.metadata.id}:${darkTheme.metadata.id}:${isDark ? 'dark' : 'light'}`;

  const diffRootRef = useRef<HTMLDivElement | null>(null);
  const diffContainerRef = useRef<HTMLDivElement | null>(null);
  const diffInstanceRef = useRef<PierreFileDiff<unknown> | null>(null);
  const sharedVirtualizerRef = useRef<SharedVirtualizer | null>(null);
  const [, forceUpdate] = React.useReducer((x) => x + 1, 0);
  const workerPool = useWorkerPool(renderSideBySide ? 'split' : 'unified');

  const lightResolvedTheme = useMemo(() => getResolvedShikiTheme(lightTheme), [lightTheme]);
  const darkResolvedTheme = useMemo(() => getResolvedShikiTheme(darkTheme), [darkTheme]);

  // Fast-path: update base diff theme vars immediately.
  // Without this, already-mounted diffs can keep old bg/bars until async highlight completes.
  React.useLayoutEffect(() => {
    const root = diffRootRef.current;
    if (!root) return;

    const container = root.querySelector('diffs-container') as HTMLElement | null;
    if (!container) return;

    const currentResolved = isDark ? darkResolvedTheme : lightResolvedTheme;

    const getColor = (
      resolved: typeof currentResolved,
      key: string,
    ): string | undefined => {
      const colors = resolved.colors as Record<string, string> | undefined;
      return colors?.[key];
    };

    const lightAdd = getColor(lightResolvedTheme, 'terminal.ansiGreen');
    const lightDel = getColor(lightResolvedTheme, 'terminal.ansiRed');
    const lightMod = getColor(lightResolvedTheme, 'terminal.ansiBlue');

    const darkAdd = getColor(darkResolvedTheme, 'terminal.ansiGreen');
    const darkDel = getColor(darkResolvedTheme, 'terminal.ansiRed');
    const darkMod = getColor(darkResolvedTheme, 'terminal.ansiBlue');

    // Apply on host; vars inherit into shadow root.
    container.style.setProperty('--shiki-light', lightResolvedTheme.fg);
    container.style.setProperty('--shiki-light-bg', lightResolvedTheme.bg);
    if (lightAdd) container.style.setProperty('--shiki-light-addition-color', lightAdd);
    if (lightDel) container.style.setProperty('--shiki-light-deletion-color', lightDel);
    if (lightMod) container.style.setProperty('--shiki-light-modified-color', lightMod);

    container.style.setProperty('--shiki-dark', darkResolvedTheme.fg);
    container.style.setProperty('--shiki-dark-bg', darkResolvedTheme.bg);
    if (darkAdd) container.style.setProperty('--shiki-dark-addition-color', darkAdd);
    if (darkDel) container.style.setProperty('--shiki-dark-deletion-color', darkDel);
    if (darkMod) container.style.setProperty('--shiki-dark-modified-color', darkMod);

    container.style.setProperty('--diffs-bg', currentResolved.bg);
    container.style.setProperty('--diffs-fg', currentResolved.fg);

    const currentAdd = isDark ? darkAdd : lightAdd;
    const currentDel = isDark ? darkDel : lightDel;
    const currentMod = isDark ? darkMod : lightMod;
    if (currentAdd) container.style.setProperty('--diffs-addition-color-override', currentAdd);
    if (currentDel) container.style.setProperty('--diffs-deletion-color-override', currentDel);
    if (currentMod) container.style.setProperty('--diffs-modified-color-override', currentMod);

    // Pierre also inlines theme styles on <pre> inside shadow root.
    // Patch it too so already-expanded diffs switch instantly.
    const pre = container.shadowRoot?.querySelector('pre') as HTMLPreElement | null;
    if (pre) {
      pre.style.setProperty('--shiki-light', lightResolvedTheme.fg);
      pre.style.setProperty('--shiki-light-bg', lightResolvedTheme.bg);
      if (lightAdd) pre.style.setProperty('--shiki-light-addition-color', lightAdd);
      if (lightDel) pre.style.setProperty('--shiki-light-deletion-color', lightDel);
      if (lightMod) pre.style.setProperty('--shiki-light-modified-color', lightMod);

      pre.style.setProperty('--shiki-dark', darkResolvedTheme.fg);
      pre.style.setProperty('--shiki-dark-bg', darkResolvedTheme.bg);
      if (darkAdd) pre.style.setProperty('--shiki-dark-addition-color', darkAdd);
      if (darkDel) pre.style.setProperty('--shiki-dark-deletion-color', darkDel);
      if (darkMod) pre.style.setProperty('--shiki-dark-modified-color', darkMod);

      pre.style.setProperty('--diffs-bg', currentResolved.bg);
      pre.style.setProperty('--diffs-fg', currentResolved.fg);
      if (currentAdd) pre.style.setProperty('--diffs-addition-color-override', currentAdd);
      if (currentDel) pre.style.setProperty('--diffs-deletion-color-override', currentDel);
      if (currentMod) pre.style.setProperty('--diffs-modified-color-override', currentMod);
    }
  }, [darkResolvedTheme, diffThemeKey, isDark, lightResolvedTheme]);


  const options = useMemo(() => ({
    theme: {
      dark: darkTheme.metadata.id,
      light: lightTheme.metadata.id,
    },
    themeType: isDark ? ('dark' as const) : ('light' as const),
    diffStyle: renderSideBySide ? ('split' as const) : ('unified' as const),
    diffIndicators: 'none' as const,
    hunkSeparators: 'line-info-basic' as const,
    // Perf: disable intra-line diff (word-level) globally.
    lineDiffType: 'none' as const,
    maxLineDiffLength: 1000,
    maxLineLengthForHighlighting: 1000,
    expansionLineCount: 20,
    overflow: wrapLines ? ('wrap' as const) : ('scroll' as const),
    disableFileHeader: true,
    enableLineSelection: true,
    enableHoverUtility: false,
    onLineSelected: handleSelectionChange,
    unsafeCSS: WEBKIT_SCROLL_FIX_CSS,
    renderAnnotation,
  }), [darkTheme.metadata.id, isDark, lightTheme.metadata.id, renderSideBySide, wrapLines, handleSelectionChange, renderAnnotation]);


  const lineAnnotations = useMemo(() => {
    return buildPierreLineAnnotations({
      drafts: fileDrafts,
      editingDraftId,
      selection,
    });
  }, [editingDraftId, fileDrafts, selection]);

  const lineAnnotationsRef = useRef(lineAnnotations);

  useEffect(() => {
    lineAnnotationsRef.current = lineAnnotations;
  }, [lineAnnotations]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const container = diffContainerRef.current;
    if (!container) return;
    if (!workerPool) return;

    // Dispose previous instance
    diffInstanceRef.current?.cleanUp();
    diffInstanceRef.current = null;
    sharedVirtualizerRef.current?.release();
    sharedVirtualizerRef.current = null;
    container.innerHTML = '';

    const sharedVirtualizer = acquireSharedVirtualizer(container);
    sharedVirtualizerRef.current = sharedVirtualizer;

    const instance = sharedVirtualizer
      ? new VirtualizedFileDiff(
          options as unknown as FileDiffOptions<unknown>,
          sharedVirtualizer.virtualizer,
          VIRTUAL_METRICS,
          workerPool,
        )
      : new PierreFileDiff(options as unknown as FileDiffOptions<unknown>, workerPool);
    diffInstanceRef.current = instance;
    lastAppliedSelectionRef.current = null;

    const oldFile: FileContents = {
      name: fileName || '',
      contents: original,
      lang: language as FileContents['lang'],
      cacheKey: `old:${diffThemeKey}:${fileName}:${makeContentCacheKey(original)}`,
    };
    const newFile: FileContents = {
      name: fileName || '',
      contents: modified,
      lang: language as FileContents['lang'],
      cacheKey: `new:${diffThemeKey}:${fileName}:${makeContentCacheKey(modified)}`,
    };

    instance.render({
      oldFile,
      newFile,
      lineAnnotations: lineAnnotationsRef.current,
      containerWrapper: container,
    });

    requestAnimationFrame(() => {
      forceUpdate();
    });

    return () => {
      instance.cleanUp();
      if (diffInstanceRef.current === instance) {
        diffInstanceRef.current = null;
      }
      sharedVirtualizer?.release();
      if (sharedVirtualizer && sharedVirtualizerRef.current === sharedVirtualizer) {
        sharedVirtualizerRef.current = null;
      }
      container.innerHTML = '';
    };
  }, [diffThemeKey, fileName, language, modified, options, original, workerPool]);

  useEffect(() => {
    const instance = diffInstanceRef.current;
    if (!instance) return;

    instance.setLineAnnotations(lineAnnotations);
    requestAnimationFrame(() => {
      if (diffInstanceRef.current !== instance) return;
      try {
        instance.rerender();
      } catch (err) {
        void err;
      }
      forceUpdate();
    });
  }, [lineAnnotations]);

  useEffect(() => {
    const instance = diffInstanceRef.current;
    if (!instance) return;

    // Only push selection to the diff when clearing.
    // User-driven selections already originate from the diff itself.
    if (selection !== null) {
      return;
    }

    // Guard against feedback loops and redundant updates
    const lastApplied = lastAppliedSelectionRef.current;
    if (isSameSelection(selection, lastApplied)) {
      return;
    }

    try {
      isApplyingSelectionRef.current = true;
      instance.setSelectedLines(selection);
      lastAppliedSelectionRef.current = selection;
    } catch {
      // ignore
    } finally {
      isApplyingSelectionRef.current = false;
    }
  }, [selection]);

  useEffect(() => {
    const container = diffContainerRef.current;
    if (!container) return;

    let rafId: number | null = null;
    let cleanup = () => {};

    const setup = () => {
      const host = container.querySelector('diffs-container');
      const shadowRoot = host?.shadowRoot;
      if (!shadowRoot) {
        rafId = requestAnimationFrame(setup);
        return;
      }

      const onClickCapture = (event: Event) => {
        if (!(event instanceof MouseEvent) || event.button !== 0) return;
        if (!(event.target instanceof Element)) return;

        const numberCell = event.target.closest('[data-column-number]');
        if (!(numberCell instanceof HTMLElement)) return;

        const lineRaw = numberCell.getAttribute('data-column-number');
        const lineNumber = lineRaw ? parseInt(lineRaw, 10) : NaN;
        if (Number.isNaN(lineNumber)) return;

        const side = resolveClickedSide(numberCell);

        handleSelectionChange({
          start: lineNumber,
          end: lineNumber,
          side,
        });

        event.preventDefault();
        event.stopPropagation();
      };

      shadowRoot.addEventListener('click', onClickCapture, true);
      cleanup = () => {
        shadowRoot.removeEventListener('click', onClickCapture, true);
      };
    };

    setup();

    return () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      cleanup();
    };
  }, [diffThemeKey, fileName, handleSelectionChange, resolveClickedSide]);

  // MutationObserver to trigger re-renders when annotation DOM nodes are added/removed
  useEffect(() => {
    const container = diffContainerRef.current;
    if (!container) return;

    let observer: MutationObserver | null = null;
    let rafId: number | null = null;

    const setupObserver = () => {
      const diffsContainer = container.querySelector('diffs-container');
      if (!(diffsContainer instanceof HTMLElement)) return;

      const shadowRoot = diffsContainer.shadowRoot;

      observer = new MutationObserver(() => {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          forceUpdate();
          rafId = null;
        });
      });

      observer.observe(diffsContainer, { childList: true, subtree: true });
      if (shadowRoot) {
        observer.observe(shadowRoot, { childList: true, subtree: true });
      }
    };

    const timeoutId = setTimeout(setupObserver, 100);

    return () => {
      clearTimeout(timeoutId);
      if (rafId) cancelAnimationFrame(rafId);
      observer?.disconnect();
    };
  }, [diffThemeKey, fileName]);

  if (typeof window === 'undefined') {
    return null;
  }

  const commentOverlays = (
    <PierreDiffCommentOverlays
      diffRootRef={diffRootRef}
      drafts={fileDrafts}
      selection={selection}
      editingDraftId={editingDraftId}
      commentText={commentText}
      fileLabel={(fileName?.split('/').pop()) ?? ''}
      onSave={handleSaveComment}
      onCancel={handleCancelComment}
      onEdit={(draft) => {
        applySelection({
          start: draft.startLine,
          end: draft.endLine,
          side: draft.side === 'original' ? 'deletions' : 'additions',
        });
        startEdit(draft);
      }}
      onDelete={deleteDraft}
    />
  );

  if (layout === 'fill') {
    return (
      <div className={cn("flex flex-col relative", "size-full")} data-diff-virtual-root>
        <div className="flex-1 relative min-h-0">
          <ScrollableOverlay
            outerClassName="pierre-diff-wrapper size-full"
            disableHorizontal={false}
            fillContainer={true}
            data-diff-virtual-content
          >
            <div ref={diffRootRef} className="size-full relative">
              <div ref={diffContainerRef} className="size-full" />
            </div>
          </ScrollableOverlay>
          {commentOverlays}
        </div>
      </div>
    );
  }

  // Fallback for 'inline' layout
  return (
    <div className={cn("relative", "w-full")}>
      <div ref={diffRootRef} className="pierre-diff-wrapper w-full overflow-x-auto overflow-y-visible relative">
        <div ref={diffContainerRef} className="w-full" />
      </div>
      {commentOverlays}
    </div>
  );
};
