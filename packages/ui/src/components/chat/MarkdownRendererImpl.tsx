import React from 'react';
import morphdom from 'morphdom';
import { renderMermaidASCII, renderMermaidSVG } from 'beautiful-mermaid';
import type { Part } from '@opencode-ai/sdk/v2';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { getDefaultTheme } from '@/lib/theme/themes';
import type { Theme } from '@/types/theme';
import { openAppLinkWithConfirmation } from './appLinkConfirmation';
import { attachAppLinkInteractions } from './appLinkInteractions';
import type { ToolPopupContent } from './message/types';
import { FadeInOnReveal } from './message/FadeInOnReveal';
import { useUIStore } from '@/stores/useUIStore';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { EditorAPI } from '@/lib/api/types';
import { isDesktopLocalOriginActive, isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { ensureOutsideFileGrantForDesktop } from '@/lib/outsideFileGrants';
import { getDirectoryForFilePath, isFilePathWithinDirectory, toAbsoluteFilePath } from '@/lib/path-utils';
import {
  getCachedMarkdownBlocks,
  renderMarkdownBlocks,
  renderMarkdownSync,
  type MarkdownImageMode,
} from './markdown/markdownCore';
import { ensureMarkdownShikiTheme } from './markdown/markdownTheme';
import { getMarkdownSyntaxVars } from './markdown/markdownSyntaxVars';
import {
  attachMarkdownInteractions,
  applyMarkdownCodeBlockWrapState,
  decorateMarkdown,
  getMarkdownCodeText,
  type DecorateContext,
  type DecorateLabels,
  type MermaidControlOptions,
  type MermaidRender,
} from './markdown/decorate';
import { findTextPosition } from './markdown/textPosition';
import { createMermaidViewerRegistry, MERMAID_BLOCK_SELECTOR, shouldRefreshMermaidViewers } from './markdown/mermaidViewer';
import {
  BLOCK_PATH_TOKEN_RE,
  isAbsoluteReferencePath,
  localPathFromFileUrl,
  normalizeReferencePath,
  parseFileReference,
  type ParsedFileReference,
} from './fileReferenceParser';
import { fileReferenceExists } from './fileReferenceStat';
import { streamPerfCount, streamPerfObserve } from '@/stores/utils/streamDebug';
import { detachedMarkdownDomCache, type DetachedMarkdownDomKey } from './markdown/detachedMarkdownDomCache';
import { TimelineRevealGateContext } from './timelineRevealGate';
import { getRuntimeKey } from '@/lib/runtime-switch';

const useCurrentMermaidTheme = () => {
  const themeSystem = useOptionalThemeSystem();
  const fallbackLight = getDefaultTheme(false);
  const fallbackDark = getDefaultTheme(true);

  return themeSystem?.currentTheme
    ?? (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? fallbackDark
      : fallbackLight);
};

const useLinkInteractions = ({
  containerRef,
  enabled,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  enabled?: boolean;
}) => {
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    return attachAppLinkInteractions(container, {
      allowExternalHttp: enabled !== false,
      openAppLink: (href) => void openAppLinkWithConfirmation(href),
      openExternalHttp: (href) => void openExternalUrl(href),
    });
  }, [containerRef, enabled]);
};

const DEFAULT_MERMAID_CONTROLS: MermaidControlOptions = {
  download: true,
  copy: true,
  showPanZoomControls: true,
};
const DEFAULT_MERMAID_FULLSCREEN_ENABLED = true;

const stripLeadingFrontmatter = (markdown: string): string => {
  const frontmatterMatch = markdown.match(
    /^(?:\uFEFF)?(---|\+\+\+)[^\S\r\n]*\r?\n[\s\S]*?\r?\n\1[^\S\r\n]*(?:\r?\n|$)/,
  );

  if (!frontmatterMatch) {
    return markdown;
  }

  return markdown.slice(frontmatterMatch[0].length);
};

export type MarkdownVariant = 'assistant' | 'tool' | 'reasoning';

interface MarkdownRendererProps {
  content: string;
  part?: Part;
  messageId: string;
  isAnimated?: boolean;
  skipFadeIn?: boolean;
  className?: string;
  isStreaming?: boolean;
  disableStreamAnimation?: boolean;
  variant?: MarkdownVariant;
  onShowPopup?: (content: ToolPopupContent) => void;
  enableFileReferences?: boolean;
}

const FILE_LINK_SELECTOR = '[data-openchamber-file-link="true"]';
const BLOCK_PATH_TOKEN_ATTR = 'data-openchamber-block-path-token';
const BLOCK_PATH_TOKEN_SELECTOR = `[${BLOCK_PATH_TOKEN_ATTR}]`;
const CODE_BLOCK_PATH_SCANNED_ATTR = 'data-openchamber-block-paths-scanned';
// Matches `path[:line[:col]]` or `path:start-end` inside shell/grep-style
// output. The regex is defined in `./fileReferenceParser`; the inline-code
// pipeline reads full text content rather than using this regex.
const MAX_BLOCK_CODE_SCAN_LENGTH = 200_000;
const FILE_REFERENCE_LINK_LIMIT = 80;
const VSCODE_FILE_REFERENCE_LINK_LIMIT = 40;
const FILE_REFERENCE_ANNOTATION_DELAY_MS = 160;

const getFileReferenceLinkLimit = (): number => (
  isVSCodeRuntime() ? VSCODE_FILE_REFERENCE_LINK_LIMIT : FILE_REFERENCE_LINK_LIMIT
);

const KNOWN_FILE_BASENAMES = new Set([
  'dockerfile',
  'makefile',
  'readme',
  'license',
  '.env',
  '.gitignore',
  '.npmrc',
]);

const normalizePath = (value: string): string => {
  return normalizeReferencePath(value);
};

const isAbsolutePath = (value: string): boolean => {
  return isAbsoluteReferencePath(value);
};

const toAbsolutePath = (basePath: string, targetPath: string): string => {
  return toAbsoluteFilePath(basePath, targetPath);
};

const hasFileExtension = (path: string): boolean => {
  const base = path.split('/').filter(Boolean).pop() ?? '';
  if (!base || base.endsWith('.')) {
    return false;
  }
  return /\.[A-Za-z0-9_-]{1,16}$/.test(base);
};

const isLikelyFilePathValue = (path: string): boolean => {
  if (!path || path.startsWith('--') || path.includes('://')) {
    return false;
  }

  if (/[<>]/.test(path) || /\s{2,}/.test(path)) {
    return false;
  }

  const normalized = normalizePath(path);
  const baseName = normalized.split('/').filter(Boolean).pop() ?? normalized;
  if (!baseName || baseName === '.' || baseName === '..') {
    return false;
  }

  const base = baseName.toLowerCase();
  if (KNOWN_FILE_BASENAMES.has(base) || (base.startsWith('.') && base.length > 1)) {
    return true;
  }

  return hasFileExtension(normalized);
};

const isLikelyFilePath = (value: string): boolean => {
  const parsed = parseFileReference(value);
  if (!parsed) {
    return false;
  }
  return isLikelyFilePathValue(parsed.path);
};

const unwrapBlockCodePathTokens = (container: HTMLElement): void => {
  const tokenSpans = container.querySelectorAll<HTMLElement>(BLOCK_PATH_TOKEN_SELECTOR);
  for (const span of Array.from(tokenSpans)) {
    span.replaceWith(container.ownerDocument.createTextNode(span.textContent ?? ''));
  }

  const scannedBlocks = container.querySelectorAll<HTMLElement>(`code[${CODE_BLOCK_PATH_SCANNED_ATTR}]`);
  for (const codeBlock of Array.from(scannedBlocks)) {
    codeBlock.removeAttribute(CODE_BLOCK_PATH_SCANNED_ATTR);
    codeBlock.normalize();
  }
};

const extractPathCandidateFromElement = (element: HTMLElement): string => {
  if (element.tagName.toLowerCase() === 'a') {
    const href = element.getAttribute('href')?.trim();
    const fileUrlPath = href ? localPathFromFileUrl(href) : null;
    if (fileUrlPath) {
      return fileUrlPath;
    }
    if (href && isLikelyFilePath(href)) {
      return href;
    }
  }

  return (element.textContent || '').trim();
};

// Walks text nodes inside `<pre><code>` subtrees and wraps any substring that
// looks like a `path[:line[:col]]` reference in a span carrying
// `data-openchamber-block-path-token`. `annotateFileLinks` then promotes those
// spans into clickable file links via the same existing pipeline used for
// inline code (parseFileReference → fileReferenceExists → openFileReference).
//
// Idempotent: each `<code>` node is marked with
// `data-openchamber-block-paths-scanned` once processed so the walk is not
// repeated on the same element. When the renderer replaces the `<code>` subtree
// (e.g. on content change during streaming), the new element lacks the marker and
// will be rescanned on the next mutation-observer callback.
const wrapBlockCodePathTokens = (container: HTMLElement): void => {
  const codeBlocks = container.querySelectorAll<HTMLElement>('pre code');
  if (codeBlocks.length === 0) {
    return;
  }

  const doc = container.ownerDocument;
  if (!doc) {
    return;
  }

  for (const codeBlock of Array.from(codeBlocks)) {
    if (codeBlock.getAttribute(CODE_BLOCK_PATH_SCANNED_ATTR) === 'true') {
      continue;
    }

    // Skip absurdly large code blocks to keep DOM work bounded.
    if ((codeBlock.textContent ?? '').length > MAX_BLOCK_CODE_SCAN_LENGTH) {
      codeBlock.setAttribute(CODE_BLOCK_PATH_SCANNED_ATTR, 'true');
      continue;
    }

    const walker = doc.createTreeWalker(codeBlock, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let currentNode = walker.nextNode();
    while (currentNode) {
      const textNode = currentNode as Text;
      if (!textNode.parentElement?.closest('[data-md-code-line-number]')) {
        textNodes.push(textNode);
      }
      currentNode = walker.nextNode();
    }

    const fullText = getMarkdownCodeText(codeBlock);
    if (!fullText.includes('.')) {
      codeBlock.setAttribute(CODE_BLOCK_PATH_SCANNED_ATTR, 'true');
      continue;
    }

    BLOCK_PATH_TOKEN_RE.lastIndex = 0;
    const matches: Array<{ start: number; end: number; raw: string }> = [];
    let match: RegExpExecArray | null = BLOCK_PATH_TOKEN_RE.exec(fullText);
    while (match) {
      const raw = match[0];
      if (raw && isLikelyFilePath(raw)) {
        matches.push({ start: match.index, end: match.index + raw.length, raw });
      }
      match = BLOCK_PATH_TOKEN_RE.exec(fullText);
    }

    for (const { start, end, raw } of matches.reverse()) {
      const startPosition = findTextPosition(textNodes, start, 'right');
      const endPosition = findTextPosition(textNodes, end, 'left');
      if (!startPosition || !endPosition) {
        continue;
      }

      const range = doc.createRange();
      range.setStart(startPosition.node, startPosition.offset);
      range.setEnd(endPosition.node, endPosition.offset);

      const span = doc.createElement('span');
      span.setAttribute(BLOCK_PATH_TOKEN_ATTR, 'true');
      span.textContent = raw;

      range.deleteContents();
      range.insertNode(span);
    }

    codeBlock.setAttribute(CODE_BLOCK_PATH_SCANNED_ATTR, 'true');
  }
};

const getResolvedReference = (rawValue: string, effectiveDirectory: string): (ParsedFileReference & { resolvedPath: string }) | null => {
  const parsed = parseFileReference(rawValue);
  if (!parsed || !isLikelyFilePathValue(parsed.path)) {
    return null;
  }

  const resolvedPath = isAbsolutePath(parsed.path)
    ? normalizePath(parsed.path)
    : toAbsolutePath(effectiveDirectory, parsed.path);
  if (!resolvedPath) {
    return null;
  }

  return {
    ...parsed,
    resolvedPath,
  };
};

const getContextDirectory = (effectiveDirectory: string, resolvedPath: string): string => {
  return effectiveDirectory || getDirectoryForFilePath(effectiveDirectory, resolvedPath);
};

const useFileReferenceInteractions = ({
  containerRef,
  effectiveDirectory,
  editor,
  preferRuntimeEditor,
  enabled,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  effectiveDirectory: string;
  editor?: EditorAPI;
  preferRuntimeEditor?: boolean;
  enabled: boolean;
}) => {
  const annotationDebounceRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    // Wait for the real directory: annotating against an empty/fallback
    // directory issues stat probes under the wrong cache key (and the wrong
    // server directory), and the pass reruns anyway once the directory
    // resolves — every link ended up verified twice.
    if (enabled && !effectiveDirectory) {
      return;
    }
    let cancelled = false;
    const fileReferenceLinkLimit = getFileReferenceLinkLimit();
    // On mobile surfaces, file-reference highlighting is disabled entirely — not
    // just visually. The annotation pass is what issues the filesystem `stat`
    // probes (fileReferenceExists → /api/fs/stat), so skipping it here guarantees
    // no probe requests are ever sent from a mobile runtime.
    const fileReferencesEnabled = enabled && !isMobileSurfaceRuntime();

    const clearFileLinkAttributes = (candidate: HTMLElement) => {
      candidate.removeAttribute('data-openchamber-file-link');
      candidate.removeAttribute('data-openchamber-file-ref');
      candidate.removeAttribute('data-openchamber-file-path');
      if (candidate.getAttribute('title') === 'Open file') {
        candidate.removeAttribute('title');
      }
      if (candidate.tagName.toLowerCase() !== 'a') {
        candidate.removeAttribute('role');
        candidate.removeAttribute('tabindex');
      }
    };

    const clearAnnotatedFileLinks = () => {
      const annotated = container.querySelectorAll<HTMLElement>(FILE_LINK_SELECTOR);
      for (const candidate of Array.from(annotated)) {
        clearFileLinkAttributes(candidate);
      }
      unwrapBlockCodePathTokens(container);
    };

    if (!fileReferencesEnabled) {
      clearAnnotatedFileLinks();
      return;
    }

    const scheduleAnnotation = (delayMs = 0) => {
      if (annotationDebounceRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(annotationDebounceRef.current);
      }
      if (typeof window === 'undefined') {
        annotateFileLinks();
        return;
      }
      annotationDebounceRef.current = window.setTimeout(() => {
        annotationDebounceRef.current = null;
        window.requestAnimationFrame(() => {
          if (!cancelled) {
            annotateFileLinks();
          }
        });
      }, delayMs);
    };

    const annotateFileLinks = () => {
      annotationWriteDepth += 1;
      try {
        annotateFileLinksInner();
      } finally {
        // Let the mutation events from our own writes flush before the
        // observer starts listening for real content changes again.
        queueMicrotask(() => {
          annotationWriteDepth -= 1;
        });
      }
    };

    const annotateFileLinksInner = () => {
      if (fileReferencesEnabled) {
        wrapBlockCodePathTokens(container);
      }
      const candidates = container.querySelectorAll<HTMLElement>(
        `[data-markdown="inline-code"], a, ${BLOCK_PATH_TOKEN_SELECTOR}`,
      );
      let linkedCount = 0;

      for (const candidate of Array.from(candidates)) {
        const rawCandidate = extractPathCandidateFromElement(candidate);
        const resolved = getResolvedReference(rawCandidate, effectiveDirectory);
        clearFileLinkAttributes(candidate);

        if (!resolved) {
          continue;
        }

        if (linkedCount >= fileReferenceLinkLimit) {
          continue;
        }

        linkedCount += 1;

        const canGrantOutsideFile = isDesktopShell()
          && isDesktopLocalOriginActive()
          && !isFilePathWithinDirectory(resolved.resolvedPath, effectiveDirectory);
        const existsPromise = canGrantOutsideFile
          ? Promise.resolve(true)
          : fileReferenceExists(resolved.resolvedPath, effectiveDirectory);

        void existsPromise.then((exists) => {
          if (cancelled || !exists || !container.contains(candidate)) {
            return;
          }

          const latestRawCandidate = extractPathCandidateFromElement(candidate);
          const latestResolved = getResolvedReference(latestRawCandidate, effectiveDirectory);
          if (!latestResolved || latestResolved.resolvedPath !== resolved.resolvedPath) {
            return;
          }

          candidate.setAttribute('data-openchamber-file-link', 'true');
          candidate.setAttribute('data-openchamber-file-ref', latestRawCandidate);
          candidate.setAttribute('data-openchamber-file-path', latestResolved.resolvedPath);
          candidate.setAttribute('title', 'Open file');
          if (candidate.tagName.toLowerCase() !== 'a') {
            candidate.setAttribute('role', 'button');
            candidate.setAttribute('tabindex', '0');
          }
        });
      }
    };

    const openFileReference = async (sourceElement: HTMLElement) => {
      const raw = sourceElement.getAttribute('data-openchamber-file-ref') || extractPathCandidateFromElement(sourceElement);
      const resolved = getResolvedReference(raw, effectiveDirectory);
      if (!resolved) {
        return;
      }

      const contextDirectory = getContextDirectory(effectiveDirectory, resolved.resolvedPath);
      if (preferRuntimeEditor && editor) {
        void editor.openFile(
          resolved.resolvedPath,
          Number.isFinite(resolved.line ?? Number.NaN)
            ? Math.max(1, Math.trunc(resolved.line as number))
            : undefined,
          Number.isFinite(resolved.column ?? Number.NaN)
            ? Math.max(1, Math.trunc(resolved.column as number))
            : undefined,
        );
        return;
      }

      if (!isFilePathWithinDirectory(resolved.resolvedPath, effectiveDirectory)) {
        await ensureOutsideFileGrantForDesktop(resolved.resolvedPath, effectiveDirectory);
      }

      const uiStore = useUIStore.getState();
      if (Number.isFinite(resolved.line ?? Number.NaN)) {
        uiStore.openContextFileAtLine(
          contextDirectory,
          resolved.resolvedPath,
          Math.max(1, Math.trunc(resolved.line as number)),
          Number.isFinite(resolved.column ?? Number.NaN)
            ? Math.max(1, Math.trunc(resolved.column as number))
            : 1,
        );
      } else {
        uiStore.openContextFile(contextDirectory, resolved.resolvedPath);
      }
    };

    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const fileRefElement = target.closest(FILE_LINK_SELECTOR);
      if (!(fileRefElement instanceof HTMLElement)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      void openFileReference(fileRefElement);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }

      const target = event.target;
      if (!(target instanceof HTMLElement) || target.getAttribute('data-openchamber-file-link') !== 'true') {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      void openFileReference(target);
    };

    scheduleAnnotation(FILE_REFERENCE_ANNOTATION_DELAY_MS);

    // Our own annotation writes (path-token wrapping, attribute updates) fire
    // childList mutations too; observing them re-ran the whole pass — every
    // link was scanned and verified twice per render.
    let annotationWriteDepth = 0;
    const observer = new MutationObserver(() => {
      if (annotationWriteDepth > 0) return;
      scheduleAnnotation(FILE_REFERENCE_ANNOTATION_DELAY_MS);
    });
    observer.observe(container, {
      childList: true,
      subtree: true,
    });

    container.addEventListener('click', handleClick);
    container.addEventListener('keydown', handleKeyDown);

    return () => {
      cancelled = true;
      if (annotationDebounceRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(annotationDebounceRef.current);
      }
      annotationDebounceRef.current = null;
      observer.disconnect();
      container.removeEventListener('click', handleClick);
      container.removeEventListener('keydown', handleKeyDown);
    };
  }, [containerRef, editor, effectiveDirectory, preferRuntimeEditor, enabled]);
};

const useMermaidInlineInteractions = ({
  containerRef,
  onShowPopup,
  enableFullscreen,
  enablePanZoom,
  allowMermaidWheelEvents,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  onShowPopup?: (content: ToolPopupContent) => void;
  enableFullscreen?: boolean;
  enablePanZoom?: boolean;
  allowMermaidWheelEvents?: boolean;
}) => {
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const handleMermaidClick = (event: MouseEvent) => {
      if (!enableFullscreen || !onShowPopup) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      if (target.closest('button, a, [role="button"]')) {
        return;
      }

      const block = target.closest(MERMAID_BLOCK_SELECTOR);
      if (!block) {
        return;
      }

      if (block instanceof HTMLElement && block.hasAttribute('data-mermaid-suppress-click')) {
        block.removeAttribute('data-mermaid-suppress-click');
        return;
      }

      const renderedBlocks = Array.from(container.querySelectorAll<HTMLElement>(MERMAID_BLOCK_SELECTOR));
      const blockIndex = renderedBlocks.indexOf(block as HTMLElement);
      if (blockIndex < 0) {
        return;
      }

      const source = block instanceof HTMLElement ? block.getAttribute('data-md-source') : null;
      if (!source || source.trim().length === 0) {
        return;
      }

      const filename = `Diagram ${blockIndex + 1}`;
      onShowPopup({
        open: true,
        title: filename,
        content: '',
        metadata: {
          tool: 'mermaid-preview',
          filename,
        },
        mermaid: {
          url: `data:text/plain;charset=utf-8,${encodeURIComponent(source)}`,
          source,
          filename,
        },
      });
    };

    const handleInlineWheel = (event: WheelEvent) => {
      if (allowMermaidWheelEvents || ((event.ctrlKey || event.metaKey) && enablePanZoom)) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const block = target.closest(MERMAID_BLOCK_SELECTOR);
      if (!block) {
        return;
      }

      // Keep regular page scroll while preventing Streamdown inline wheel-zoom handlers.
      event.stopPropagation();
    };

    container.addEventListener('click', handleMermaidClick);
    container.addEventListener('wheel', handleInlineWheel, { capture: true, passive: true });

    return () => {
      container.removeEventListener('click', handleMermaidClick);
      container.removeEventListener('wheel', handleInlineWheel, true);
    };
  }, [allowMermaidWheelEvents, containerRef, enableFullscreen, enablePanZoom, onShowPopup]);
};

// ---------------------------------------------------------------------------
// Rendering core: marked -> math -> shiki -> sanitize -> decorate -> morphdom
// ---------------------------------------------------------------------------

// Mermaid layout is expensive; `decorate` would otherwise re-render every
// diagram on every paced-stream step (~40/sec). Memoize by theme+mode+source
// so a stable diagram is laid out once and served from cache thereafter.
const MERMAID_RENDER_CACHE = new Map<string, MermaidRender>();
const MERMAID_RENDER_CACHE_MAX = 100;
const MARKDOWN_DECORATION_ID_ATTR = 'data-md-decoration-id';

// True when the container already holds exactly these settled blocks with the
// current decoration. The first paint of a remounted message is served from
// the block cache; when that paint is already final, the async render would
// only parse, highlight, sanitize, and morph the same HTML into place again.
const domMatchesRenderedBlocks = (
  target: HTMLElement,
  blocks: ReadonlyArray<{ id: string }>,
  decorationId: string,
): boolean => {
  const children = target.children;
  if (children.length !== blocks.length) return false;
  for (let index = 0; index < blocks.length; index += 1) {
    const child = children[index];
    if (
      !child
      || child.getAttribute('data-md-id') !== blocks[index]?.id
      || child.getAttribute(MARKDOWN_DECORATION_ID_ATTR) !== decorationId
    ) {
      return false;
    }
  }
  return true;
};
const MARKDOWN_DECORATION_IDS = new WeakMap<DecorateContext, string>();
let nextMarkdownDecorationId = 0;
const MARKDOWN_DOM_CACHE_MAX_SOURCE_CHARS = 200_000;

const getMarkdownDecorationId = (ctx: DecorateContext): string => {
  const existing = MARKDOWN_DECORATION_IDS.get(ctx);
  if (existing) return existing;
  const id = `decoration-${nextMarkdownDecorationId}`;
  nextMarkdownDecorationId += 1;
  MARKDOWN_DECORATION_IDS.set(ctx, id);
  return id;
};

const cachedMermaidRender = (key: string, compute: () => MermaidRender): MermaidRender => {
  const existing = MERMAID_RENDER_CACHE.get(key);
  if (existing) {
    MERMAID_RENDER_CACHE.delete(key);
    MERMAID_RENDER_CACHE.set(key, existing);
    return existing;
  }
  const value = compute();
  MERMAID_RENDER_CACHE.set(key, value);
  if (MERMAID_RENDER_CACHE.size > MERMAID_RENDER_CACHE_MAX) {
    const oldest = MERMAID_RENDER_CACHE.keys().next().value;
    if (oldest) MERMAID_RENDER_CACHE.delete(oldest);
  }
  return value;
};

const mermaidColorsFromTheme = (theme: Theme) => ({
  bg: theme.colors.surface.elevated,
  fg: theme.colors.surface.foreground,
  line: theme.colors.interactive.border,
  accent: theme.colors.primary.base,
  muted: theme.colors.surface.mutedForeground,
  surface: theme.colors.surface.muted,
  border: theme.colors.interactive.border,
  transparent: true,
  font: 'system-ui, sans-serif',
});

const useDecorateContext = (
  currentTheme: Theme,
  deferCodeLineNumberSync: boolean,
  onPreviewLoopback?: (url: string) => void,
  mermaidControls: MermaidControlOptions = DEFAULT_MERMAID_CONTROLS,
): DecorateContext => {
  const { t } = useI18n();
  const labels: DecorateLabels = React.useMemo(() => ({
    copy: t('markdownRenderer.code.actions.copyTitle'),
    copied: t('markdownRenderer.code.actions.copiedTitle'),
    enableCodeWrap: t('markdownRenderer.code.actions.enableWrapTitle'),
    disableCodeWrap: t('markdownRenderer.code.actions.disableWrapTitle'),
    copyTable: t('markdownRenderer.table.actions.copyTitle'),
    downloadTable: t('markdownRenderer.table.actions.downloadTitle'),
    copyDiagram: t('markdownRenderer.mermaid.actions.copySourceTitle'),
    downloadDiagram: t('markdownRenderer.mermaid.actions.downloadSvgTitle'),
    zoomInDiagram: t('markdownRenderer.mermaid.actions.zoomInTitle'),
    zoomOutDiagram: t('markdownRenderer.mermaid.actions.zoomOutTitle'),
    resetDiagramView: t('markdownRenderer.mermaid.actions.resetViewTitle'),
    previewLabel: t('terminalView.preview.open'),
    previewTitle: t('terminalView.preview.openTitle'),
  }), [t]);

  const codeBlockLineWrap = useUIStore((state) => state.codeBlockLineWrap);
  const setCodeBlockLineWrap = useUIStore((state) => state.setCodeBlockLineWrap);
  const toggleCodeBlockLineWrap = React.useCallback(() => {
    setCodeBlockLineWrap(!useUIStore.getState().codeBlockLineWrap);
  }, [setCodeBlockLineWrap]);

  return React.useMemo<DecorateContext>(() => {
    const colors = mermaidColorsFromTheme(currentTheme);
    const mode = useUIStore.getState().mermaidRenderingMode;
    const themeId = currentTheme.metadata?.id ?? 'theme';
    const renderMermaid = (source: string): MermaidRender =>
      cachedMermaidRender(`${themeId}:${mode}:${source}`, () => {
        try {
          if (mode === 'ascii') return { ascii: renderMermaidASCII(source) };
          return { svg: renderMermaidSVG(source, colors) };
        } catch {
          return {};
        }
      });
    return { labels, mermaidControls, codeBlockLineWrap, deferCodeLineNumberSync, onToggleCodeBlockLineWrap: toggleCodeBlockLineWrap, renderMermaid, onPreviewLoopback };
  }, [currentTheme, labels, mermaidControls, codeBlockLineWrap, deferCodeLineNumberSync, toggleCodeBlockLineWrap, onPreviewLoopback]);
};

// Runs the async render pipeline into the container and keeps a stable
// delegated interaction listener attached.
const useMorphdomMarkdown = ({
  containerRef,
  text,
  streaming,
  imageMode = 'inline',
  syntaxVars,
  ctx,
  domCacheKey,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  text: string;
  streaming: boolean;
  imageMode?: MarkdownImageMode;
  syntaxVars: Record<string, string>;
  ctx: DecorateContext;
  domCacheKey?: DetachedMarkdownDomKey | null;
}) => {
  React.useEffect(() => {
    ensureMarkdownShikiTheme();
  }, []);

  const mermaidViewerRef = React.useRef<ReturnType<typeof createMermaidViewerRegistry> | null>(null);
  const renderRevisionRef = React.useRef(0);
  // A provisional first paint (blocks not in the settled cache) holds the
  // timeline reveal until the async render lands, so the session opens with
  // final code highlighting instead of a visible restyle.
  const revealGate = React.useContext(TimelineRevealGateContext);
  const releaseRevealHoldRef = React.useRef<(() => void) | null>(null);
  const releaseRevealHold = React.useCallback(() => {
    releaseRevealHoldRef.current?.();
    releaseRevealHoldRef.current = null;
  }, []);
  React.useEffect(() => releaseRevealHold, [releaseRevealHold]);
  // Only DOM that was actually restored or completed by the async pipeline is
  // eligible for capture. A fallback from an earlier content revision is not.
  const mountedDomRef = React.useRef<{
    key: DetachedMarkdownDomKey;
    copiedLabel: string;
  } | null>(null);
  const refreshMermaidViewers = React.useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    if (!mermaidViewerRef.current) {
      if (!shouldRefreshMermaidViewers(container)) {
        return;
      }
      mermaidViewerRef.current = createMermaidViewerRegistry(container);
      return;
    }
    mermaidViewerRef.current.refresh();
  }, [containerRef]);

  React.useLayoutEffect(() => {
    renderRevisionRef.current += 1;
    mountedDomRef.current = null;
  }, [ctx, imageMode, streaming, text]);

  React.useLayoutEffect(() => {
    if (!domCacheKey) return;
    const container = containerRef.current;
    const target = container?.querySelector<HTMLElement>('[data-markdown-content]') ?? container;
    if (!target || target.childNodes.length > 0) return;

    const cached = detachedMarkdownDomCache.take(domCacheKey);
    if (cached) {
      target.appendChild(cached);
      const decorationId = getMarkdownDecorationId(ctx);
      for (const block of Array.from(target.children)) {
        block.setAttribute(MARKDOWN_DECORATION_ID_ATTR, decorationId);
      }
      for (const [key, value] of Object.entries(syntaxVars)) target.style.setProperty(key, value);
      applyMarkdownCodeBlockWrapState(target, ctx.codeBlockLineWrap, ctx.labels);
      mountedDomRef.current = {
        key: domCacheKey,
        copiedLabel: ctx.labels.copied,
      };
      streamPerfCount('ui.markdown_renderer.dom_cache.hit');
    }
  }, [containerRef, ctx, domCacheKey, syntaxVars, text.length]);

  // Restoration follows the cache identity above, but capture must only happen
  // when this renderer lifecycle ends. Combining both in one keyed effect would
  // detach the live DOM on ordinary content, theme, or locale updates.
  React.useLayoutEffect(() => {
    const container = containerRef.current;
    const target = container?.querySelector<HTMLElement>('[data-markdown-content]') ?? container;
    if (!target) return;
    return () => {
      const mountedDom = mountedDomRef.current;
      if (!mountedDom) return;
      // Viewer controllers and transient interaction state belong to the
      // current renderer instance and must not cross the cache boundary.
      if (target.childNodes.length === 0 || shouldRefreshMermaidViewers(target)) return;
      if (Array.from(target.children).some((block) => !block.hasAttribute('data-md-id'))) return;
      if (target.querySelector('[data-md-copy-pending]')) return;
      const selection = window.getSelection();
      if (selection?.rangeCount && !selection.isCollapsed && selection.getRangeAt(0).intersectsNode(target)) return;
      const openMenu = target.querySelector<HTMLElement>('[data-md-menu]:not(.hidden)');
      const copiedButton = Array.from(target.querySelectorAll<HTMLButtonElement>('[data-md-action]'))
        .some((button) => button.getAttribute('title') === mountedDom.copiedLabel);
      if (openMenu || copiedButton) return;

      const fragment = document.createDocumentFragment();
      fragment.append(...Array.from(target.childNodes));
      detachedMarkdownDomCache.store({ ...mountedDom.key, fragment });
      streamPerfCount('ui.markdown_renderer.dom_cache.capture');
    };
  }, [containerRef]);

  // Synchronous first paint: while the async parse is in-flight, show escaped
  // plain text immediately so there is no blank frame on initial mount. Only
  // runs when the target is empty — subsequent updates keep the prior rich DOM
  // until the next async render morphs in (no flash). Mirrors OpenCode's
  // `initialValue: fallback(text)` resource pattern.
  React.useLayoutEffect(() => {
    const container = containerRef.current;
    const target = container?.querySelector<HTMLElement>('[data-markdown-content]') ?? container;
    if (!target) return;
    const decorationId = getMarkdownDecorationId(ctx);
    if (text && target.childNodes.length === 0) {
      const cachedBlocks = !streaming ? getCachedMarkdownBlocks(text, imageMode) : null;
      if (cachedBlocks) {
        let hasMermaidBlock = false;
        for (const cachedBlock of cachedBlocks) {
          const block = document.createElement('div');
          block.setAttribute('data-md-block', '');
          block.style.display = 'contents';
          block.innerHTML = cachedBlock.html;
          decorateMarkdown(block, ctx);
          block.setAttribute('data-md-id', cachedBlock.id);
          block.setAttribute(MARKDOWN_DECORATION_ID_ATTR, decorationId);
          hasMermaidBlock ||= shouldRefreshMermaidViewers(block);
          target.appendChild(block);
        }
        if (hasMermaidBlock) refreshMermaidViewers();
      } else {
        if (!streaming && !releaseRevealHoldRef.current) {
          releaseRevealHoldRef.current = revealGate?.hold() ?? null;
        }
        const block = document.createElement('div');
        block.setAttribute('data-md-block', '');
        block.style.display = 'contents';
        block.innerHTML = renderMarkdownSync(text, imageMode);
        decorateMarkdown(block, ctx);
        block.setAttribute(MARKDOWN_DECORATION_ID_ATTR, decorationId);
        target.appendChild(block);
        if (shouldRefreshMermaidViewers(block)) refreshMermaidViewers();
      }
    } else if (!mermaidViewerRef.current && shouldRefreshMermaidViewers(target)) {
      // StrictMode re-runs this setup after the cleanup probe. The DOM remains,
      // but the viewer registry does not, so recreate it without reinstalling
      // or re-decorating ordinary blocks.
      refreshMermaidViewers();
    }
  }, [containerRef, text, streaming, imageMode, ctx, refreshMermaidViewers]);

  React.useEffect(() => () => {
    mermaidViewerRef.current?.cleanup();
    mermaidViewerRef.current = null;
  }, []);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const target = container.querySelector<HTMLElement>('[data-markdown-content]') ?? container;
    let active = true;
    const renderRevision = renderRevisionRef.current;
    const decorationId = getMarkdownDecorationId(ctx);

    if (!streaming) {
      const cachedBlocks = getCachedMarkdownBlocks(text, imageMode);
      if (cachedBlocks && domMatchesRenderedBlocks(target, cachedBlocks, decorationId)) {
        mountedDomRef.current = domCacheKey
          ? { key: domCacheKey, copiedLabel: ctx.labels.copied }
          : null;
        streamPerfCount('ui.markdown_renderer.settled_paint.reused');
        releaseRevealHold();
        return;
      }
    }

    void renderMarkdownBlocks(text, streaming, imageMode).then((blocks) => {
      if (!active || renderRevisionRef.current !== renderRevision) return;
      const existing = Array.from(target.children) as HTMLElement[];

      // Reconcile per block: only re-morph blocks whose content changed, leaving
      // stable leading blocks untouched. Keeps per-stream-step DOM work bounded
      // to the trailing (growing) block instead of the whole message.
      let enteredThisPass = 0;
      blocks.forEach((block, index) => {
        let el = existing[index];
        let isNewBlock = false;
        if (!el) {
          el = document.createElement('div');
          el.setAttribute('data-md-block', '');
          el.style.display = 'contents';
          target.appendChild(el);
          isNewBlock = true;
        }
        if (el.getAttribute('data-md-id') === block.id) {
          if (el.getAttribute(MARKDOWN_DECORATION_ID_ATTR) !== decorationId) {
            const hasMermaidBlock = shouldRefreshMermaidViewers(el);
            if (hasMermaidBlock) {
              mermaidViewerRef.current?.cleanup();
              mermaidViewerRef.current = null;
            }
            const replacement = document.createElement('div');
            replacement.setAttribute('data-md-block', '');
            replacement.style.display = 'contents';
            replacement.innerHTML = block.html;
            decorateMarkdown(replacement, ctx);
            replacement.setAttribute('data-md-id', block.id);
            replacement.setAttribute(MARKDOWN_DECORATION_ID_ATTR, decorationId);
            el.replaceWith(replacement);
            if (hasMermaidBlock || shouldRefreshMermaidViewers(replacement)) refreshMermaidViewers();
          }
          if (!mermaidViewerRef.current && shouldRefreshMermaidViewers(el)) {
            refreshMermaidViewers();
          }
          return;
        }

        const temp = document.createElement('div');
        temp.innerHTML = block.html;
        decorateMarkdown(temp, ctx);
        if (isNewBlock && streaming && index > 0) {
          // A freshly committed block enters with a short reveal. The class
          // goes on the block's children — the wrapper is display:contents
          // and cannot animate — and the transform never changes layout, so
          // row measurement stays exact. Skipped for the first block so a
          // full initial render does not shimmer. Several blocks committed
          // in one tick cascade with a small stagger instead of popping in
          // together.
          const delayMs = Math.min(enteredThisPass, 4) * 55;
          enteredThisPass += 1;
          for (const child of Array.from(temp.children)) {
            child.classList.add('oc-md-block-enter');
            if (delayMs > 0 && child instanceof HTMLElement) {
              child.style.setProperty('--oc-md-enter-delay', `${delayMs}ms`);
            }
          }
        }
        const hadMermaidBlock = shouldRefreshMermaidViewers(el);
        const tempHasMermaidBlock = shouldRefreshMermaidViewers(temp);
        morphdom(el, temp, {
          childrenOnly: true,
          onBeforeElUpdated: (fromEl, toEl) => !fromEl.isEqualNode(toEl),
        });
        el.setAttribute('data-md-id', block.id);
        el.setAttribute(MARKDOWN_DECORATION_ID_ATTR, decorationId);
        if (hadMermaidBlock || tempHasMermaidBlock || shouldRefreshMermaidViewers(el)) {
          refreshMermaidViewers();
        }
      });

      const hadMermaidBeforeTrailingCleanup = shouldRefreshMermaidViewers(target);
      let removedMermaidBlock = false;
      for (let i = existing.length - 1; i >= blocks.length; i -= 1) {
        const removed = existing[i];
        if (removed && shouldRefreshMermaidViewers(removed)) {
          removedMermaidBlock = true;
        }
        removed?.remove();
      }
      if (removedMermaidBlock || (existing.length > blocks.length && hadMermaidBeforeTrailingCleanup)) {
        refreshMermaidViewers();
      }
      mountedDomRef.current = domCacheKey
        ? { key: domCacheKey, copiedLabel: ctx.labels.copied }
        : null;
      releaseRevealHold();
    });

    return () => {
      active = false;
    };
  }, [containerRef, ctx, domCacheKey, imageMode, refreshMermaidViewers, releaseRevealHold, streaming, text]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    return attachMarkdownInteractions(container, ctx);
  }, [containerRef, ctx]);

  // Apply syntax CSS variables imperatively so they survive morphdom updates.
  React.useEffect(() => {
    const container = containerRef.current;
    const target = container?.querySelector<HTMLElement>('[data-markdown-content]') ?? container;
    if (!target) return;
    for (const [key, value] of Object.entries(syntaxVars)) {
      target.style.setProperty(key, value);
    }
  }, [containerRef, syntaxVars]);

  React.useEffect(() => {
    const container = containerRef.current;
    const target = container?.querySelector<HTMLElement>('[data-markdown-content]') ?? container;
    if (!target) return;
    if (ctx.deferCodeLineNumberSync) return;
    applyMarkdownCodeBlockWrapState(target, ctx.codeBlockLineWrap, ctx.labels);
  }, [containerRef, ctx.codeBlockLineWrap, ctx.deferCodeLineNumberSync, ctx.labels]);

};

const markdownContentClassName = (variant: MarkdownVariant): string =>
  variant === 'tool'
    ? 'markdown-content markdown-tool'
    : variant === 'reasoning'
      ? 'markdown-content markdown-reasoning'
      : 'markdown-content leading-relaxed';

const MarkdownRendererImpl: React.FC<MarkdownRendererProps> = ({
  content,
  part,
  messageId,
  isAnimated = true,
  skipFadeIn = false,
  className,
  isStreaming = false,
  disableStreamAnimation = false,
  variant = 'assistant',
  onShowPopup,
  enableFileReferences = true,
}) => {
  streamPerfCount('ui.markdown_renderer.render');
  if (isStreaming) streamPerfCount('ui.markdown_renderer.render.streaming');
  streamPerfObserve('ui.markdown_renderer.content_len', content.length);
  const currentTheme = useCurrentMermaidTheme();
  const { editor, runtime } = useRuntimeAPIs();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const openContextPreview = useUIStore((state) => state.openContextPreview);

  const handlePreviewLoopback = React.useCallback((url: string) => {
    if (!effectiveDirectory) return;
    openContextPreview(effectiveDirectory, url);
  }, [effectiveDirectory, openContextPreview]);

  const live = isStreaming && !disableStreamAnimation;

  useMermaidInlineInteractions({
    containerRef,
    onShowPopup,
    enableFullscreen: DEFAULT_MERMAID_FULLSCREEN_ENABLED,
    enablePanZoom: DEFAULT_MERMAID_CONTROLS.showPanZoomControls,
  });
  useFileReferenceInteractions({
    containerRef,
    effectiveDirectory,
    editor,
    preferRuntimeEditor: runtime.isVSCode,
    enabled: enableFileReferences && !isStreaming,
  });
  useLinkInteractions({ containerRef });

  const syntaxVars = React.useMemo(() => getMarkdownSyntaxVars(currentTheme), [currentTheme]);
  const ctx = useDecorateContext(currentTheme, live, effectiveDirectory ? handlePreviewLoopback : undefined, DEFAULT_MERMAID_CONTROLS);
  const { locale } = useI18n();
  const imageMode: MarkdownImageMode = variant === 'assistant' ? 'label' : 'inline';
  const settledPart = part
    && (part.type === 'text' || part.type === 'reasoning')
    && part.time?.end !== undefined
    ? part
    : null;
  const runtimeKey = getRuntimeKey();
  // Memoized on scalar identities, not the part object: sync-store reducers
  // recreate part objects on unrelated updates, and an object-identity dep
  // re-ran the async render pipeline for identical content.
  const settledSessionID = settledPart?.sessionID;
  const settledMessageID = settledPart?.messageID;
  const settledPartID = settledPart?.id;
  const domCacheKey = React.useMemo<DetachedMarkdownDomKey | null>(() => {
    // Streaming, unfinished, oversized, and identity-less Markdown continues
    // through the normal rendering pipeline and never retains detached DOM.
    if (isStreaming || !settledSessionID || !settledMessageID || !settledPartID || content.length === 0 || content.length > MARKDOWN_DOM_CACHE_MAX_SOURCE_CHARS) return null;
    // content.length is a cheap fingerprint: an edited or reverted part that
    // re-materializes under the same id must not restore the old DOM.
    return {
      scope: `${runtimeKey}\0${settledSessionID}`,
      id: `${settledMessageID}\0${settledPartID}\0${imageMode}\0${content.length}`,
      locale,
      directory: effectiveDirectory,
    };
  }, [content.length, effectiveDirectory, imageMode, isStreaming, locale, runtimeKey, settledSessionID, settledMessageID, settledPartID]);
  // Identity for the fade-in wrapper: a new part/message restarts the animation.
  const fadeKey = `markdown-${part?.id ? `part-${part.id}` : `message-${messageId}`}`;

  useMorphdomMarkdown({
    containerRef,
    text: content,
    streaming: live,
    imageMode,
    syntaxVars,
    ctx,
    domCacheKey,
  });

  const markdownContent = (
    <div className={cn('break-words w-full min-w-0', className)} ref={containerRef}>
      <div className={markdownContentClassName(variant)} data-markdown-content />
    </div>
  );

  if (isAnimated) {
    return (
      <FadeInOnReveal key={fadeKey} skipAnimation={skipFadeIn}>
        {markdownContent}
      </FadeInOnReveal>
    );
  }

  return markdownContent;
};

export const MarkdownRenderer = React.memo(MarkdownRendererImpl, (prev, next) => {
  return prev.content === next.content
    && prev.isStreaming === next.isStreaming
    && prev.disableStreamAnimation === next.disableStreamAnimation
    && prev.variant === next.variant
    && prev.isAnimated === next.isAnimated
    && prev.skipFadeIn === next.skipFadeIn
    && prev.className === next.className
    && prev.messageId === next.messageId
    && prev.onShowPopup === next.onShowPopup
    && prev.enableFileReferences === next.enableFileReferences
    && prev.part?.id === next.part?.id;
});

const SimpleMarkdownRendererImpl: React.FC<{
  content: string;
  className?: string;
  variant?: MarkdownVariant;
  // App links remain confirmed even where ordinary HTTP link handling is off.
  disableLinkSafety?: boolean;
  stripFrontmatter?: boolean;
  onShowPopup?: (content: ToolPopupContent) => void;
  mermaidControls?: MermaidControlOptions;
  allowMermaidWheelEvents?: boolean;
  enableFileReferences?: boolean;
}> = ({
  content,
  className,
  variant = 'assistant',
  disableLinkSafety,
  stripFrontmatter = false,
  onShowPopup,
  mermaidControls = DEFAULT_MERMAID_CONTROLS,
  allowMermaidWheelEvents = false,
  enableFileReferences = true,
}) => {
  const { editor, runtime } = useRuntimeAPIs();
  const currentTheme = useCurrentMermaidTheme();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const effectiveDirectory = useEffectiveDirectory() ?? '';

  const renderedContent = React.useMemo(
    () => (stripFrontmatter ? stripLeadingFrontmatter(content) : content),
    [content, stripFrontmatter],
  );

  useMermaidInlineInteractions({
    containerRef,
    onShowPopup,
    enableFullscreen: DEFAULT_MERMAID_FULLSCREEN_ENABLED,
    enablePanZoom: mermaidControls.showPanZoomControls,
    allowMermaidWheelEvents,
  });
  useFileReferenceInteractions({
    containerRef,
    effectiveDirectory,
    editor,
    preferRuntimeEditor: runtime.isVSCode,
    enabled: enableFileReferences,
  });
  useLinkInteractions({ containerRef, enabled: !disableLinkSafety });

  const syntaxVars = React.useMemo(() => getMarkdownSyntaxVars(currentTheme), [currentTheme]);
  const ctx = useDecorateContext(currentTheme, false, undefined, mermaidControls);

  useMorphdomMarkdown({
    containerRef,
    text: renderedContent,
    streaming: false,
    syntaxVars,
    ctx,
  });

  return (
    <div className={cn('break-words w-full min-w-0', className)} ref={containerRef}>
      <div className={markdownContentClassName(variant)} data-markdown-content />
    </div>
  );
};

export const SimpleMarkdownRenderer = React.memo(SimpleMarkdownRendererImpl, (prev, next) => {
  const prevMermaidControls = prev.mermaidControls ?? DEFAULT_MERMAID_CONTROLS;
  const nextMermaidControls = next.mermaidControls ?? DEFAULT_MERMAID_CONTROLS;

  return prev.content === next.content
    && prev.variant === next.variant
    && prev.className === next.className
    && prev.disableLinkSafety === next.disableLinkSafety
    && prev.stripFrontmatter === next.stripFrontmatter
    && prev.onShowPopup === next.onShowPopup
    && prevMermaidControls.download === nextMermaidControls.download
    && prevMermaidControls.copy === nextMermaidControls.copy
    && prevMermaidControls.showPanZoomControls === nextMermaidControls.showPanZoomControls
    && prev.allowMermaidWheelEvents === next.allowMermaidWheelEvents
    && prev.enableFileReferences === next.enableFileReferences;
});
