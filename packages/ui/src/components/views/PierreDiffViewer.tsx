import React, { useMemo, useRef, useCallback, useEffect } from 'react';
import {
  areFilesEqual,
  areOptionsEqual,
  FileDiff as PierreFileDiff,
  VirtualizedFileDiff,
  Virtualizer,
  type FileContents,
  type FileDiffMetadata,
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

import { useDeviceInfo } from '@/lib/device';
import { cn } from '@/lib/utils';


// Threshold (bytes) above which syntax highlighting is degraded for performance
const LARGE_CONTENT_BYTES = 500_000;

interface PierreDiffViewerProps {
  original: string;
  modified: string;
  fileDiff?: FileDiffMetadata;
  language: string;
  fileName?: string;
  renderSideBySide: boolean;
  wrapLines?: boolean;
  layout?: 'fill' | 'inline';
}

/**
 * Base CSS injected into Pierre's Shadow DOM. Pins font-family/size to the
 * app tokens (so Files view and Diff view render at the same scale on mobile)
 * and enables touch-friendly line interactions. Re-exported so plain
 * <PierreFile> consumers (e.g. `MobileFilesSurface`) can inject the same.
 */
export const PIERRE_RUNTIME_BASE_CSS = `
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
`;

// CSS injected into Pierre's Shadow DOM for WebKit scroll optimization +
// diff-specific separator height. Note: avoid will-change and contain:paint
// as they break resize behavior.
const WEBKIT_SCROLL_FIX_CSS = `
  ${PIERRE_RUNTIME_BASE_CSS}

  :host {
    --diffs-bg-separator-override: var(--surface-elevated);
  }

  [data-diff-header],
  [data-diff] {
    [data-separator] {
      height: 24px !important;
    }
  }

  [data-separator="line-info-basic"] {
    height: 24px !important;
    background: var(--diffs-bg) !important;
    position: relative;
  }

  [data-diff-type="single"] [data-gutter],
  [data-diff-type="split"] [data-deletions] [data-gutter] {
    [data-separator-wrapper] {
      position: absolute;
      left: 100%;
      display: flex;
      align-items: center;
      gap: unset;
      width: max-content;
      background: transparent;
      color: var(--diffs-fg-number);
      font-family: var(--diffs-header-font-family, var(--font-sans));
      font-size: 0.75rem;
      line-height: 1;
      margin-left: calc(-2ch - 2px);
    }

    [data-separator-wrapper][data-separator-multi-button] {
      margin-left: calc(-3ch - 2px);
    }

    [data-expand-button],
    [data-separator-content] {
      display: block;
      align-self: unset;
      min-width: unset;
      min-height: unset;
      padding: 0;
      flex-shrink: 0;
      grid-column: unset;
      border: none;
      width: auto;
      height: auto;
      background-color: transparent;
      color: inherit;
      font: inherit;
    }

    [data-expand-button]:not([data-expand-all-button]) {
      &[data-expand-down]::before {
        content: '\\2191';
      }

      &[data-expand-up]::before {
        content: '\\2193';
      }

      &[data-expand-both]::before {
        content: '\\2195';
      }

      svg {
        display: none;
      }
    }

    [data-separator-content] {
      background: transparent;
      margin-left: calc(2px + 1ch);
    }

    [data-expand-all-button] {
      position: relative;
      margin-left: 14px;
      text-transform: lowercase;
    }

    [data-expand-all-button]::before {
      content: '';
      display: block;
      position: absolute;
      top: 50%;
      left: -8px;
      margin-top: -1px;
      width: 3px;
      height: 3px;
      border-radius: 2px;
      background-color: var(--diffs-fg-number);
      pointer-events: none;
    }

    [data-separator-content]:hover,
    [data-expand-button]:hover,
    [data-expand-all-button]:hover {
      color: var(--diffs-fg);
    }

    [data-expand-all-button]:hover {
      text-decoration: underline;
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

const extractSelectedCode = (
  original: string,
  modified: string,
  fileDiff: FileDiffMetadata | undefined,
  range: SelectedLineRange,
): string => {
  // Default to modified if side is ambiguous, as users mostly comment on new code
  const isOriginal = range.side === 'deletions';
  const content = fileDiff
    ? (isOriginal ? fileDiff.deletionLines : fileDiff.additionLines).join('')
    : (isOriginal ? original : modified);
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

const isScrollable = (value: string): boolean =>
  value === 'auto' || value === 'scroll' || value === 'overlay';

const findScrollParent = (node: HTMLElement | null): HTMLElement | null => {
  let current = node?.parentElement ?? null;
  while (current) {
    const style = window.getComputedStyle(current);
    if (isScrollable(style.overflowY)) return current;
    current = current.parentElement;
  }
  return null;
};

const preserveScrollPosition = (wrapper: HTMLElement | null, container: HTMLElement | null): (() => void) => {
  if (!wrapper || !container || typeof window === 'undefined') return () => {};

  const scrollParent = findScrollParent(wrapper);
  if (!scrollParent) return () => {};

  const height = container.getBoundingClientRect().height;
  if (!height) return () => {};

  const top = wrapper.getBoundingClientRect().top - scrollParent.getBoundingClientRect().top;
  const previousMinHeight = container.style.minHeight;
  container.style.minHeight = `${Math.ceil(height)}px`;

  let done = false;
  return () => {
    if (done) return;
    done = true;
    container.style.minHeight = previousMinHeight;

    const nextTop = wrapper.getBoundingClientRect().top - scrollParent.getBoundingClientRect().top;
    const delta = nextTop - top;
    if (delta) {
      scrollParent.scrollTop += delta;
    }
  };
};

const waitForDiffReady = (
  container: HTMLElement,
  onReady: () => void,
): (() => void) => {
  if (typeof window === 'undefined') return () => {};

  let frameId: number | null = null;
  let observer: MutationObserver | null = null;
  let cancelled = false;

  const finish = () => {
    if (cancelled) return;
    observer?.disconnect();
    observer = null;
    frameId = window.requestAnimationFrame(() => {
      frameId = window.requestAnimationFrame(() => {
        if (!cancelled) onReady();
      });
    });
  };

  const getRoot = (): ShadowRoot | undefined => {
    const host = container.querySelector('diffs-container');
    return host?.shadowRoot ?? undefined;
  };

  const isReady = (root = getRoot()) => {
    return Boolean(root?.querySelector('[data-line]'));
  };

  if (isReady()) {
    finish();
  } else if (typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => {
      const root = getRoot();
      if (!root) return;
      if (isReady(root)) {
        finish();
        return;
      }
      observer?.disconnect();
      observer = new MutationObserver(() => {
        if (isReady(root)) {
          finish();
        }
      });
      observer.observe(root, { childList: true, subtree: true });
    });
    observer.observe(container, { childList: true, subtree: true });
  } else {
    frameId = window.requestAnimationFrame(finish);
  }

  return () => {
    cancelled = true;
    observer?.disconnect();
    if (frameId !== null) {
      window.cancelAnimationFrame(frameId);
    }
  };
};

type SharedVirtualizer = {
  virtualizer: Virtualizer;
  root: Document | HTMLElement;
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
  spacing: 0,
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
    root: target.root,
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

const wakeVirtualizer = (
  instance: PierreFileDiff<PierreAnnotationData>,
  sharedVirtualizer: SharedVirtualizer | null,
  forceUpdate: () => void,
): (() => void) => {
  if (typeof window === 'undefined') return () => {};

  const frameIds: number[] = [];
  const run = () => {
    try {
      instance.rerender();
    } catch {
      // ignored
    }

    const root = sharedVirtualizer?.root;
    if (root instanceof HTMLElement) {
      root.dispatchEvent(new Event('scroll', { bubbles: false }));
    } else {
      document.dispatchEvent(new Event('scroll', { bubbles: false }));
    }

    window.dispatchEvent(new Event('resize'));
    forceUpdate();
  };

  frameIds.push(window.requestAnimationFrame(run));
  frameIds.push(window.requestAnimationFrame(() => {
    frameIds.push(window.requestAnimationFrame(run));
  }));

  return () => {
    for (const frameId of frameIds) {
      window.cancelAnimationFrame(frameId);
    }
  };
};

export const PierreDiffViewer: React.FC<PierreDiffViewerProps> = ({
  original,
  modified,
  fileDiff,
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

  const { isMobile } = useDeviceInfo();

  const diffCommentController = useInlineCommentController<SelectedLineRange>({
    source: 'diff',
    fileLabel: fileName || 'unknown',
    language,
    getCodeForRange: (range) => extractSelectedCode(original, modified, fileDiff, range),
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
  const commentTextRef = useRef('');
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

  useEffect(() => {
    commentTextRef.current = commentText;
  }, [commentText]);

  const handleSelectionChange = useCallback((range: SelectedLineRange | null) => {
    // Ignore callbacks while we're programmatically applying selection
    if (isApplyingSelectionRef.current) {
      return;
    }

    const prevSelection = selectionRef.current;

    if (!range && prevSelection && commentTextRef.current.trim()) {
      return;
    }

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

  const isLargeContent = useMemo(() => {
    if (fileDiff) {
      const deletionLength = fileDiff.deletionLines.reduce((total, line) => total + line.length, 0);
      const additionLength = fileDiff.additionLines.reduce((total, line) => total + line.length, 0);
      return Math.max(deletionLength, additionLength) > LARGE_CONTENT_BYTES;
    }

    return Math.max(original.length, modified.length) > LARGE_CONTENT_BYTES;
  }, [fileDiff, modified.length, original.length]);

  const diffRootRef = useRef<HTMLDivElement | null>(null);
  const diffContainerRef = useRef<HTMLDivElement | null>(null);
  const diffInstanceRef = useRef<PierreFileDiff<PierreAnnotationData> | null>(null);
  const sharedVirtualizerRef = useRef<SharedVirtualizer | null>(null);
  const instanceVirtualizerRef = useRef<Virtualizer | null>(null);
  const instanceWorkerPoolRef = useRef<unknown>(null);
  const instanceVirtualHunkSeparatorsRef = useRef<FileDiffOptions<PierreAnnotationData>['hunkSeparators'] | undefined>(undefined);
  const instanceFileDiffRef = useRef<FileDiffMetadata | undefined>(undefined);
  const instanceOldFileRef = useRef<FileContents | undefined>(undefined);
  const instanceNewFileRef = useRef<FileContents | undefined>(undefined);
  const [, forceUpdate] = React.useReducer((x) => x + 1, 0);
  const workerPool = useWorkerPool(isLargeContent ? 'unified' : (renderSideBySide ? 'split' : 'unified'));

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
    // Perf: degrade tokenization/highlighting for large files (>500KB)
    maxLineDiffLength: isLargeContent ? 0 : 1000,
    maxLineLengthForHighlighting: isLargeContent ? 1 : 1000,
    tokenizeMaxLineLength: isLargeContent ? 1 : 1000,
    collapsedContextThreshold: 0,
    expansionLineCount: 20,
    overflow: wrapLines ? ('wrap' as const) : ('scroll' as const),
    disableFileHeader: true,
    enableLineSelection: true,
    enableHoverUtility: false,
    onLineSelected: handleSelectionChange,
    unsafeCSS: WEBKIT_SCROLL_FIX_CSS,
    renderAnnotation,
  }), [darkTheme.metadata.id, isDark, isLargeContent, lightTheme.metadata.id, renderSideBySide, wrapLines, handleSelectionChange, renderAnnotation]);


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
    const container = diffContainerRef.current;
    return () => {
      diffInstanceRef.current?.cleanUp();
      diffInstanceRef.current = null;
      sharedVirtualizerRef.current?.release();
      sharedVirtualizerRef.current = null;
      instanceVirtualizerRef.current = null;
      instanceWorkerPoolRef.current = null;
      instanceVirtualHunkSeparatorsRef.current = undefined;
      instanceFileDiffRef.current = undefined;
      instanceOldFileRef.current = undefined;
      instanceNewFileRef.current = undefined;
      if (container) {
        container.innerHTML = '';
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const container = diffContainerRef.current;
    const wrapper = diffRootRef.current;
    if (!container) return;
    if (!workerPool) return;

    const preserveDone = preserveScrollPosition(wrapper, container);
    let sharedVirtualizer = sharedVirtualizerRef.current;
    if (!sharedVirtualizer) {
      sharedVirtualizer = acquireSharedVirtualizer(container);
      sharedVirtualizerRef.current = sharedVirtualizer;
    }
    sharedVirtualizerRef.current = sharedVirtualizer;
    const virtualizer = sharedVirtualizer?.virtualizer ?? null;

    const oldFile: FileContents | undefined = fileDiff ? undefined : {
      name: fileName || '',
      contents: original,
      lang: language as FileContents['lang'],
      cacheKey: `old:${diffThemeKey}:${fileName}:${makeContentCacheKey(original)}`,
    };
    const newFile: FileContents | undefined = fileDiff ? undefined : {
      name: fileName || '',
      contents: modified,
      lang: language as FileContents['lang'],
      cacheKey: `new:${diffThemeKey}:${fileName}:${makeContentCacheKey(modified)}`,
    };

    const targetChanged = fileDiff
      ? instanceFileDiffRef.current !== fileDiff
      : instanceFileDiffRef.current !== undefined
        || !oldFile
        || !newFile
        || !instanceOldFileRef.current
        || !instanceNewFileRef.current
        || !areFilesEqual(instanceOldFileRef.current, oldFile)
        || !areFilesEqual(instanceNewFileRef.current, newFile);

    const currentInstance = diffInstanceRef.current;
    const shouldReset = Boolean(
      currentInstance
      && (
        instanceVirtualizerRef.current !== virtualizer
        || instanceWorkerPoolRef.current !== workerPool
        || (virtualizer && (instanceVirtualHunkSeparatorsRef.current !== options.hunkSeparators || targetChanged))
      )
    );

    if (shouldReset) {
      currentInstance?.cleanUp();
      diffInstanceRef.current = null;
      container.innerHTML = '';
    }

    let instance = diffInstanceRef.current;
    const forceRender = !shouldReset && currentInstance
      ? !areOptionsEqual(currentInstance.options, options)
      : false;
    if (!instance) {
      instance = sharedVirtualizer
        ? new VirtualizedFileDiff<PierreAnnotationData>(
            options as FileDiffOptions<PierreAnnotationData>,
            sharedVirtualizer.virtualizer,
            VIRTUAL_METRICS,
            workerPool,
          )
        : new PierreFileDiff(options as FileDiffOptions<PierreAnnotationData>, workerPool);
      diffInstanceRef.current = instance;
      lastAppliedSelectionRef.current = null;
    } else {
      instance.setOptions(options as FileDiffOptions<PierreAnnotationData>);
    }

    instanceVirtualizerRef.current = virtualizer;
    instanceWorkerPoolRef.current = workerPool;
    instanceVirtualHunkSeparatorsRef.current = virtualizer ? options.hunkSeparators : undefined;
    instanceFileDiffRef.current = fileDiff;
    instanceOldFileRef.current = oldFile;
    instanceNewFileRef.current = newFile;

    if (fileDiff) {
      instance.render({
        fileDiff,
        forceRender,
        lineAnnotations: lineAnnotationsRef.current,
        containerWrapper: container,
      });
    } else {
      if (!oldFile || !newFile) return;

      instance.render({
        oldFile,
        newFile,
        forceRender,
        lineAnnotations: lineAnnotationsRef.current,
        containerWrapper: container,
      });
    }

    const cancelReady = waitForDiffReady(container, () => {
      preserveDone();
      wakeVirtualizer(instance, sharedVirtualizer, forceUpdate);
    });

    return () => {
      cancelReady();
      preserveDone();
    };
  }, [diffThemeKey, fileDiff, fileName, language, modified, options, original, workerPool]);

  useEffect(() => {
    const instance = diffInstanceRef.current;
    if (!instance) return;

    try {
      instance.setLineAnnotations(lineAnnotations);
    } catch (error) {
      console.error('Failed to apply diff line annotations', error);
      try {
        instance.setLineAnnotations([]);
      } catch {
        // ignored
      }
    }

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
      onTextChange={setCommentText}
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
