import React from 'react';
import morphdom from 'morphdom';
import { renderMermaidASCII, renderMermaidSVG } from 'beautiful-mermaid';
import type { Part } from '@/lib/opencode/model';
import { cn } from '@/lib/utils';
import { cancelWhenLayoutSettled, runWhenLayoutSettled } from '@/lib/layoutAnimation';
import { useI18n } from '@/lib/i18n';
import { isAppLinkUrl } from '@/lib/url';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { getDefaultTheme } from '@/lib/theme/themes';
import type { Theme } from '@/types/theme';
import { openAppLinkWithConfirmation } from './appLinkConfirmation';
import { attachAppLinkInteractions } from './appLinkInteractions';
import { useOpenChatLink } from './useOpenChatLink';
import { attachFileRefClickGuard, FILE_REFERENCE_LINK_SELECTOR } from './fileRefClickGuard';
import type { ToolPopupContent } from './message/types';
import { FadeInOnReveal } from './message/FadeInOnReveal';
import { useUIStore } from '@/stores/useUIStore';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { EditorAPI } from '@/lib/api/types';
import { isDesktopLocalOriginActive, isDesktopShell, isVSCodeRuntime, openDesktopPath } from '@/lib/desktop';
import { openSessionLink } from '@/lib/router/openSessionFromRoute';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { getDirectoryForFilePath, isFilePathWithinDirectory, toAbsoluteFilePath } from '@/lib/path-utils';
import {
  getCachedMarkdownBlocks,
  renderMarkdownBlocks,
  renderMarkdownBlocksSync,
  type MarkdownImageMode,
  type MarkdownRawHtmlMode,
} from './markdown/markdownCore';
import { ensureMarkdownShikiTheme } from './markdown/markdownTheme';
import { getMarkdownSyntaxVars } from './markdown/markdownSyntaxVars';
import {
  attachMarkdownInteractions,
  applyMarkdownCodeBlockWrapState,
  applyMarkdownTableWrapState,
  decorateMarkdown,
  stabilizeMarkdownTableWidths,
  type DecorateContext,
  type DecorateLabels,
  type MermaidControlOptions,
  type MermaidRender,
} from './markdown/decorate';
import type { RenderedCopyFormat } from './markdown/selectionMarkdown';
import { attachInlineMarkdownImages } from './markdown/inlineMarkdownImages';
import { attachMarkdownVideoFallback } from './markdown/markdownVideo';
import { observeMarkdownTableWidth } from './markdown/tableWidthObserver';
import { findTextPosition } from './markdown/textPosition';
import { splitFrontmatter } from './markdown/frontmatter';
import { FrontmatterProperties } from './markdown/FrontmatterProperties';
import { createMermaidViewerRegistry, MERMAID_BLOCK_SELECTOR, shouldRefreshMermaidViewers } from './markdown/mermaidViewer';
import {
  BLOCK_PATH_TOKEN_RE,
  isAbsoluteReferencePath,
  localPathFromFileUrl,
  normalizeReferencePath,
  parseFileReference,
  type ParsedFileReference,
} from './fileReferenceParser';
import { fileReferenceExists, findUniqueFileByName } from './fileReferenceStat';
import { streamPerfCount, streamPerfObserve } from '@/stores/utils/streamDebug';
import { detachedMarkdownDomCache, type DetachedMarkdownDomKey } from './markdown/detachedMarkdownDomCache';
import { applyOpenFencePatch } from './markdown/openFenceIncremental';
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

// Addresses that serve the instance this chat belongs to: the page itself
// (web), and the instance the app is connected to, which the desktop page,
// living on its own scheme, does not share an origin with. A link to either
// opens in place; one to another instance leaves the chat as before.
const resolveOwnOrigins = (): string[] => {
  if (typeof window === 'undefined') return [];
  const origins = [window.location.origin];
  try {
    const apiOrigin = new URL(getRuntimeApiBaseUrl() || window.location.href, window.location.href).origin;
    if (!origins.includes(apiOrigin)) origins.push(apiOrigin);
  } catch {
    // An unparseable runtime address adds nothing.
  }
  return origins;
};

const useMarkdownVideoFallback = (containerRef: React.RefObject<HTMLDivElement | null>) => {
  React.useEffect(() => {
    const container = containerRef.current;
    return container ? attachMarkdownVideoFallback(container) : undefined;
  }, [containerRef]);
};

const useLinkInteractions = ({
  containerRef,
  enabled,
  directory,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  enabled?: boolean;
  directory: string;
}) => {
  const openChatLink = useOpenChatLink(directory);
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    // VS Code keeps session links inert: its sessions live on its own OpenCode.
    const opensSessionLinks = !isVSCodeRuntime();
    return attachAppLinkInteractions(container, {
      allowExternalHttp: enabled !== false,
      openAppLink: (href) => void openAppLinkWithConfirmation(href),
      openExternalHttp: openChatLink,
      openSessionLink: opensSessionLinks
        ? (target) => void openSessionLink(target.sessionId, target.messageId)
        : undefined,
      ownOrigins: resolveOwnOrigins(),
    });
  }, [containerRef, enabled, openChatLink]);
};

const DEFAULT_MERMAID_CONTROLS: MermaidControlOptions = {
  download: true,
  copy: true,
  showPanZoomControls: true,
};
const DEFAULT_MERMAID_FULLSCREEN_ENABLED = true;

export type MarkdownVariant = 'assistant' | 'tool' | 'reasoning';

export interface MarkdownRendererProps {
  content: string;
  part?: Part;
  messageId: string;
  isAnimated?: boolean;
  skipFadeIn?: boolean;
  className?: string;
  isStreaming?: boolean;
  variant?: MarkdownVariant;
  onShowPopup?: (content: ToolPopupContent) => void;
  enableFileReferences?: boolean;
}

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
    if (href && isAppLinkUrl(href)) return '';
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

// A click can land before the async annotation marks a file reference
// (debounce + filesystem stat per candidate). Extract the href-derived
// candidate so the click guard can still route it to the file viewer instead
// of letting the renderer's `target="_blank"` open a new app window.
// Unlike `extractPathCandidateFromElement`, this never falls back to the link
// text: a link whose *text* is a path but whose href is a real URL keeps its
// URL behavior.
const extractHrefFileReferenceCandidate = (anchor: HTMLAnchorElement): string | null => {
  const href = anchor.getAttribute('href')?.trim();
  if (!href) {
    return null;
  }
  if (isAppLinkUrl(href)) return null;
  const fileUrlPath = localPathFromFileUrl(href);
  if (fileUrlPath) {
    return fileUrlPath;
  }
  return isLikelyFilePath(href) ? href : null;
};

// A path-like token (`path[:line[:col]]`) inside a `<pre><code>` block, by
// its offsets in the block's code text.
type BlockCodePathToken = { start: number; end: number; raw: string };

// The path-like tokens of each code block not scanned yet. Reads text only:
// code is full of things shaped like paths (`console.log`, `this.state`),
// and wrapping each one on mount restyled the block and re-serialized it for
// assistive technology. A token becomes a span only once its file is
// confirmed (`wrapBlockCodePathTokens`).
const findBlockCodePathTokens = (container: HTMLElement): Array<{ codeBlock: HTMLElement; tokens: BlockCodePathToken[] }> => {
  const blocks: Array<{ codeBlock: HTMLElement; tokens: BlockCodePathToken[] }> = [];
  for (const codeBlock of Array.from(container.querySelectorAll<HTMLElement>('pre code'))) {
    if (codeBlock.hasAttribute(CODE_BLOCK_PATH_SCANNED_ATTR)) continue;
    const tokens: BlockCodePathToken[] = [];
    // Skip absurdly large code blocks to keep the scan bounded.
    const codeText = codeBlock.textContent ?? '';
    const fullText = codeText.length > MAX_BLOCK_CODE_SCAN_LENGTH ? '' : codeText;
    if (fullText.includes('.')) {
      for (const match of fullText.matchAll(BLOCK_PATH_TOKEN_RE)) {
        const raw = match[0];
        if (raw && isLikelyFilePath(raw)) tokens.push({ start: match.index, end: match.index + raw.length, raw });
      }
    }
    blocks.push({ codeBlock, tokens });
  }
  return blocks;
};

// Wraps confirmed tokens of one code block in spans carrying
// `data-openchamber-block-path-token`, which later passes treat like inline
// code references, and marks the block scanned. A token whose text moved
// since the scan stays text.
const wrapBlockCodePathTokens = (
  codeBlock: HTMLElement,
  confirmed: Array<BlockCodePathToken & { decorate: (span: HTMLElement) => void }>,
): void => {
  const doc = codeBlock.ownerDocument;
  if (confirmed.length > 0) {
    const walker = doc.createTreeWalker(codeBlock, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node instanceof Text) textNodes.push(node);
    }
    const fullText = codeBlock.textContent ?? '';
    for (const { start, end, raw, decorate } of [...confirmed].sort((left, right) => right.start - left.start)) {
      if (fullText.slice(start, end) !== raw) continue;
      const startPosition = findTextPosition(textNodes, start, 'right');
      const endPosition = findTextPosition(textNodes, end, 'left');
      if (!startPosition || !endPosition) continue;

      const range = doc.createRange();
      range.setStart(startPosition.node, startPosition.offset);
      range.setEnd(endPosition.node, endPosition.offset);
      const span = doc.createElement('span');
      span.setAttribute(BLOCK_PATH_TOKEN_ATTR, 'true');
      span.textContent = raw;
      decorate(span);
      range.deleteContents();
      range.insertNode(span);
    }
  }
  codeBlock.setAttribute(CODE_BLOCK_PATH_SCANNED_ATTR, 'true');
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
      const annotated = container.querySelectorAll<HTMLElement>(FILE_REFERENCE_LINK_SELECTOR);
      for (const candidate of Array.from(annotated)) {
        clearFileLinkAttributes(candidate);
      }
      unwrapBlockCodePathTokens(container);
    };

    const openFileReference = async (sourceElement: HTMLElement, options?: { external: boolean }) => {
      const raw = sourceElement.getAttribute('data-openchamber-file-ref') || extractPathCandidateFromElement(sourceElement);
      const parsedReference = getResolvedReference(raw, effectiveDirectory);
      if (!parsedReference) {
        return;
      }
      // Annotation stored where the file really is, which differs from the
      // written path when a bare name was found elsewhere in the workspace.
      const storedPath = sourceElement.getAttribute('data-openchamber-file-path');
      const resolved = storedPath ? { ...parsedReference, resolvedPath: storedPath } : parsedReference;

      // Cmd/Ctrl-click hands the file to the OS, which opens it with the app
      // that owns its type; where that is not possible it opens here as usual.
      if (options?.external && isDesktopLocalOriginActive() && await openDesktopPath(resolved.resolvedPath)) {
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

    const attachClickGuard = () => attachFileRefClickGuard(container, {
      hrefCandidate: extractHrefFileReferenceCandidate,
      isResolvable: (raw) => getResolvedReference(raw, effectiveDirectory) !== null,
      openFileReference,
    });

    if (!fileReferencesEnabled) {
      clearAnnotatedFileLinks();
      if (!enabled) {
        return;
      }
      // Mobile skips the probing annotation pass, but a markdown link whose
      // href is a file path still has to open the file viewer: left to its
      // default, the WebView navigates to the path as a URL and fails.
      return attachClickGuard();
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

    // Runs our own DOM writes with the mutation observer below ignoring them.
    const writeAnnotations = (write: () => void) => {
      annotationWriteDepth += 1;
      try {
        write();
      } finally {
        // Let the mutation events from our own writes flush before the
        // observer starts listening for real content changes again.
        queueMicrotask(() => {
          annotationWriteDepth -= 1;
        });
      }
    };

    const setAttributeIfChanged = (element: HTMLElement, name: string, value: string) => {
      if (element.getAttribute(name) !== value) element.setAttribute(name, value);
    };

    const markFileLink = (candidate: HTMLElement, raw: string, targetPath: string) => {
      setAttributeIfChanged(candidate, 'data-openchamber-file-link', 'true');
      setAttributeIfChanged(candidate, 'data-openchamber-file-ref', raw);
      setAttributeIfChanged(candidate, 'data-openchamber-file-path', targetPath);
      setAttributeIfChanged(candidate, 'title', 'Open file');
      if (candidate.tagName.toLowerCase() !== 'a') {
        setAttributeIfChanged(candidate, 'role', 'button');
        setAttributeIfChanged(candidate, 'tabindex', '0');
      }
    };

    // Where a reference opens: its own path once the file is confirmed (a
    // path outside the workspace is not probed), the one workspace file of a
    // bare name (`Renderer.tsx:42`, looked up once per name), or nowhere.
    const resolveTarget = (resolved: ParsedFileReference & { resolvedPath: string }): Promise<string | null> => {
      if (!isFilePathWithinDirectory(resolved.resolvedPath, effectiveDirectory)) {
        return Promise.resolve(resolved.resolvedPath);
      }
      const isBareName = !resolved.path.includes('/') && !resolved.path.includes('\\');
      return fileReferenceExists(resolved.resolvedPath, effectiveDirectory).then((exists) => (
        exists ? resolved.resolvedPath : isBareName ? findUniqueFileByName(resolved.path, effectiveDirectory) : null
      ));
    };

    // One pass: find references, confirm them, then write every link of the
    // pass at once. Nothing is written for a reference that leads nowhere.
    const annotateFileLinks = () => {
      const candidates = container.querySelectorAll<HTMLElement>(
        `[data-markdown="inline-code"], a, ${BLOCK_PATH_TOKEN_SELECTOR}`,
      );
      let linkedCount = 0;
      const links: Array<{ candidate: HTMLElement; resolvedPath: string; target: Promise<string | null> }> = [];
      const unlinked: HTMLElement[] = [];
      for (const candidate of Array.from(candidates)) {
        const resolved = getResolvedReference(extractPathCandidateFromElement(candidate), effectiveDirectory);
        if (!resolved || linkedCount >= fileReferenceLinkLimit) {
          unlinked.push(candidate);
          continue;
        }
        linkedCount += 1;
        links.push({ candidate, resolvedPath: resolved.resolvedPath, target: resolveTarget(resolved) });
      }

      const blocks = findBlockCodePathTokens(container).map(({ codeBlock, tokens }) => ({
        codeBlock,
        tokens: tokens.flatMap((token) => {
          const resolved = getResolvedReference(token.raw, effectiveDirectory);
          if (!resolved || linkedCount >= fileReferenceLinkLimit) return [];
          linkedCount += 1;
          return [{ ...token, target: resolveTarget(resolved) }];
        }),
      }));

      writeAnnotations(() => {
        for (const candidate of unlinked) clearFileLinkAttributes(candidate);
      });
      if (links.length === 0 && blocks.length === 0) return;

      void Promise.all([
        Promise.all(links.map((link) => link.target.then((targetPath) => ({ ...link, targetPath })))),
        Promise.all(blocks.map(async ({ codeBlock, tokens }) => ({
          codeBlock,
          tokens: await Promise.all(tokens.map((token) => token.target.then((targetPath) => ({ ...token, targetPath })))),
        }))),
      ]).then(([linkResults, blockResults]) => {
        if (cancelled) return;
        writeAnnotations(() => {
          for (const { candidate, resolvedPath, targetPath } of linkResults) {
            if (!container.contains(candidate)) continue;
            const latestRaw = extractPathCandidateFromElement(candidate);
            if (getResolvedReference(latestRaw, effectiveDirectory)?.resolvedPath !== resolvedPath) continue;
            if (targetPath) markFileLink(candidate, latestRaw, targetPath);
            else clearFileLinkAttributes(candidate);
          }
          for (const { codeBlock, tokens } of blockResults) {
            if (!container.contains(codeBlock) || codeBlock.hasAttribute(CODE_BLOCK_PATH_SCANNED_ATTR)) continue;
            wrapBlockCodePathTokens(codeBlock, tokens.flatMap(({ start, end, raw, targetPath }) => (
              targetPath ? [{ start, end, raw, decorate: (span: HTMLElement) => markFileLink(span, raw, targetPath) }] : []
            )));
          }
        });
      });
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

    container.addEventListener('keydown', handleKeyDown);
    const removeClickGuard = attachClickGuard();

    return () => {
      cancelled = true;
      if (annotationDebounceRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(annotationDebounceRef.current);
      }
      annotationDebounceRef.current = null;
      observer.disconnect();
      removeClickGuard();
      container.removeEventListener('keydown', handleKeyDown);
    };
  }, [containerRef, editor, effectiveDirectory, preferRuntimeEditor, enabled]);
};

// Draws a settled assistant part's local images in place of their labels
// (markdown/inlineMarkdownImages.ts). Off while streaming and without a
// session, which the image grant route needs.
const useInlineMarkdownImages = ({
  containerRef,
  sessionId,
  messageId,
  directory,
  onShowPopup,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  sessionId: string | undefined;
  messageId: string | undefined;
  directory: string;
  onShowPopup?: (content: ToolPopupContent) => void;
}) => {
  const onShowPopupRef = React.useRef(onShowPopup);
  React.useEffect(() => {
    onShowPopupRef.current = onShowPopup;
  }, [onShowPopup]);
  const apiBaseUrl = getRuntimeApiBaseUrl();

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container || !sessionId || !messageId) return;
    return attachInlineMarkdownImages({
      container,
      sessionId,
      messageId,
      directory,
      apiBaseUrl,
      useWorkspaceFsBridge: isVSCodeRuntime(),
      onShowPopup: (content) => onShowPopupRef.current?.(content),
    });
  }, [apiBaseUrl, containerRef, directory, messageId, sessionId]);
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
/**
 * Marks the last block wrapper so CSS can trim its trailing margin by
 * attribute. `[data-md-block]:last-child` in a non-subject position made
 * Chrome restyle the whole subtree of any element that stopped being a last
 * child, which included the app root every time a tooltip or menu portal was
 * appended to <body>.
 */
const markLastMarkdownBlock = (target: HTMLElement): void => {
  const last = target.lastElementChild;
  for (const child of Array.from(target.children)) {
    if (child !== last && child.hasAttribute('data-md-last')) child.removeAttribute('data-md-last');
  }
  if (last?.hasAttribute('data-md-block') && !last.hasAttribute('data-md-last')) {
    last.setAttribute('data-md-last', '');
  }
};

const BLOCK_ENTER_CLASS = 'oc-md-block-enter';

/**
 * Drops the entrance animation streamed blocks carry. Settled blocks now keep
 * their streamed DOM, and re-attached DOM (the detached cache) would replay it.
 */
const clearBlockEnterAnimation = (target: HTMLElement): void => {
  for (const element of Array.from(target.querySelectorAll<HTMLElement>(`.${BLOCK_ENTER_CLASS}`))) {
    element.classList.remove(BLOCK_ENTER_CLASS);
    element.style.removeProperty('--oc-md-enter-delay');
  }
};

/**
 * A morph to the next step's HTML drops the entrance animation of a block
 * that just entered, since only new blocks carry it. A patched block drops it
 * the same way, so both paths leave the same DOM.
 */
const clearPatchedBlockEnterAnimation = (block: HTMLElement): void => {
  for (const child of Array.from(block.children)) {
    if (!(child instanceof HTMLElement) || !child.classList.contains(BLOCK_ENTER_CLASS)) continue;
    child.classList.remove(BLOCK_ENTER_CLASS);
    child.style.removeProperty('--oc-md-enter-delay');
    if (!child.getAttribute('style')) child.removeAttribute('style');
  }
};

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
  line: theme.colors.surface.mutedForeground,
  accent: theme.colors.primary.base,
  muted: theme.colors.surface.mutedForeground,
  surface: theme.colors.surface.muted,
  border: theme.colors.interactive.border,
  transparent: true,
  font: 'system-ui, sans-serif',
});

const readCopyFormat = (): RenderedCopyFormat => (
  useUIStore.getState().copyMessagesAsPlainText ? 'plain' : 'markdown'
);

const useDecorateContext = (
  currentTheme: Theme,
  onPreviewLoopback?: (url: string) => void,
  mermaidControls: MermaidControlOptions = DEFAULT_MERMAID_CONTROLS,
): DecorateContext => {
  const { t } = useI18n();
  const labels: DecorateLabels = React.useMemo(() => ({
    copy: t('markdownRenderer.code.actions.copyTitle'),
    copied: t('markdownRenderer.code.actions.copiedTitle'),
    enableCodeWrap: t('markdownRenderer.code.actions.enableWrapTitle'),
    disableCodeWrap: t('markdownRenderer.code.actions.disableWrapTitle'),
    enableTableWrap: t('markdownRenderer.table.actions.enableWrapTitle'),
    disableTableWrap: t('markdownRenderer.table.actions.disableWrapTitle'),
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
  const tableCellWrap = useUIStore((state) => state.tableCellWrap);
  const setTableCellWrap = useUIStore((state) => state.setTableCellWrap);
  const toggleTableCellWrap = React.useCallback(() => {
    setTableCellWrap(!useUIStore.getState().tableCellWrap);
  }, [setTableCellWrap]);

  const ctx = React.useMemo<DecorateContext>(() => {
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
    return {
      labels,
      mermaidControls,
      codeBlockLineWrap,
      onToggleCodeBlockLineWrap: toggleCodeBlockLineWrap,
      tableCellWrap,
      onToggleTableCellWrap: toggleTableCellWrap,
      renderMermaid,
      onPreviewLoopback,
      getCopyFormat: readCopyFormat,
    };
  }, [currentTheme, labels, mermaidControls, codeBlockLineWrap, toggleCodeBlockLineWrap, tableCellWrap, toggleTableCellWrap, onPreviewLoopback]);

  return ctx;
};

// Runs the async render pipeline into the container and keeps a stable
// delegated interaction listener attached.
const useMorphdomMarkdown = ({
  containerRef,
  text,
  streaming,
  imageMode = 'inline',
  rawHtml = 'escape',
  syntaxVars,
  ctx,
  domCacheKey,
  tableLayoutSettled,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  text: string;
  streaming: boolean;
  imageMode?: MarkdownImageMode;
  rawHtml?: MarkdownRawHtmlMode;
  syntaxVars: Record<string, string>;
  ctx: DecorateContext;
  domCacheKey?: DetachedMarkdownDomKey | null;
  tableLayoutSettled: boolean;
}) => {
  React.useEffect(() => {
    ensureMarkdownShikiTheme();
  }, []);

  const mermaidViewerRef = React.useRef<ReturnType<typeof createMermaidViewerRegistry> | null>(null);
  const renderRevisionRef = React.useRef(0);
  const tableLayoutFrameRef = React.useRef<number | null>(null);
  const stopTableWidthWatchRef = React.useRef<(() => void) | null>(null);
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
  const { tableCellWrap } = ctx;
  const tableCellWrapRef = React.useRef(tableCellWrap);
  tableCellWrapRef.current = tableCellWrap;
  const deferredTableLayout = React.useCallback(() => scheduleTableLayoutRef.current(), []);
  const layoutTables = React.useCallback(() => {
    const container = containerRef.current;
    const target = container?.querySelector<HTMLElement>('[data-markdown-content]') ?? container;
    if (!target) return;
    stabilizeMarkdownTableWidths(target, tableCellWrap);
    // Column widths are fixed for the width they were laid out in, so a
    // resized chat or document lays the tables out again: at once, from the
    // widths measured before, so the table moves with the text around it.
    // Only a table that has to be measured waits, to the end of a side
    // column's animation and the next frame.
    if (!stopTableWidthWatchRef.current && target.querySelector('table[data-markdown="table"]')) {
      stopTableWidthWatchRef.current = observeMarkdownTableWidth(target, () => {
        if (stabilizeMarkdownTableWidths(target, tableCellWrapRef.current, { cachedOnly: true })) return;
        runWhenLayoutSettled(deferredTableLayout);
      });
    }
  }, [containerRef, deferredTableLayout, tableCellWrap]);
  const scheduleTableLayout = React.useCallback(() => {
    if (!tableLayoutSettled) return;
    const previousFrame = tableLayoutFrameRef.current;
    if (previousFrame !== null) window.cancelAnimationFrame(previousFrame);
    const renderRevision = renderRevisionRef.current;
    const frame = window.requestAnimationFrame(() => {
      if (tableLayoutFrameRef.current !== frame) return;
      tableLayoutFrameRef.current = null;
      if (renderRevisionRef.current !== renderRevision) return;
      layoutTables();
    });
    tableLayoutFrameRef.current = frame;
  }, [layoutTables, tableLayoutSettled]);
  // Lays tables out in the same task as the DOM change that reset them, so
  // no frame paints them at their unmeasured width.
  const layoutTablesNow = React.useCallback(() => {
    const pendingFrame = tableLayoutFrameRef.current;
    if (pendingFrame !== null) window.cancelAnimationFrame(pendingFrame);
    tableLayoutFrameRef.current = null;
    layoutTables();
  }, [layoutTables]);
  const scheduleTableLayoutRef = React.useRef(scheduleTableLayout);
  React.useEffect(() => {
    scheduleTableLayoutRef.current = scheduleTableLayout;
  }, [scheduleTableLayout]);

  React.useEffect(() => () => {
    stopTableWidthWatchRef.current?.();
    stopTableWidthWatchRef.current = null;
    cancelWhenLayoutSettled(deferredTableLayout);
    const frame = tableLayoutFrameRef.current;
    if (frame === null) return;
    window.cancelAnimationFrame(frame);
    tableLayoutFrameRef.current = null;
  }, [deferredTableLayout]);

  // Syntax colours are CSS variables on the content node, set imperatively so
  // they survive morphdom updates. Set before the content below is inserted:
  // custom properties inherit, so writing them after the browser styled the
  // blocks restyled every one of them again, and a session opening paid that
  // for its whole transcript. Rewriting an unchanged value invalidates nothing.
  React.useLayoutEffect(() => {
    const container = containerRef.current;
    const target = container?.querySelector<HTMLElement>('[data-markdown-content]') ?? container;
    if (!target) return;
    for (const [key, value] of Object.entries(syntaxVars)) {
      target.style.setProperty(key, value);
    }
  }, [containerRef, syntaxVars]);

  React.useLayoutEffect(() => {
    renderRevisionRef.current += 1;
    mountedDomRef.current = null;
  }, [ctx, imageMode, rawHtml, streaming, text]);

  React.useLayoutEffect(() => {
    if (!domCacheKey) return;
    const container = containerRef.current;
    const target = container?.querySelector<HTMLElement>('[data-markdown-content]') ?? container;
    if (!target || target.childNodes.length > 0) return;

    const cached = detachedMarkdownDomCache.take(domCacheKey);
    if (cached) {
      target.appendChild(cached);
      markLastMarkdownBlock(target);
      const decorationId = getMarkdownDecorationId(ctx);
      for (const block of Array.from(target.children)) {
        block.setAttribute(MARKDOWN_DECORATION_ID_ATTR, decorationId);
      }
      applyMarkdownCodeBlockWrapState(target, ctx.codeBlockLineWrap, ctx.labels);
      applyMarkdownTableWrapState(target, ctx.tableCellWrap, ctx.labels);
      mountedDomRef.current = {
        key: domCacheKey,
        copiedLabel: ctx.labels.copied,
      };
      streamPerfCount('ui.markdown_renderer.dom_cache.hit');
    }
  }, [containerRef, ctx, domCacheKey, text.length]);

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

      clearBlockEnterAnimation(target);
      const fragment = document.createDocumentFragment();
      fragment.append(...Array.from(target.childNodes));
      detachedMarkdownDomCache.store({ ...mountedDom.key, fragment });
      streamPerfCount('ui.markdown_renderer.dom_cache.capture');
    };
  }, [containerRef]);

  // Synchronous first paint: while the async render (code highlighting) is in
  // flight, show the parsed blocks without colour so there is no blank frame
  // on initial mount. Only runs when the target is empty — subsequent updates
  // keep the prior rich DOM until the next async render morphs in (no flash).
  // Mirrors OpenCode's `initialValue: fallback(text)` resource pattern.
  React.useLayoutEffect(() => {
    const container = containerRef.current;
    const target = container?.querySelector<HTMLElement>('[data-markdown-content]') ?? container;
    if (!target) return;
    const decorationId = getMarkdownDecorationId(ctx);
    if (text && target.childNodes.length === 0) {
      // The first paint has the same blocks and ids as the async render. A
      // block whose code is not highlighted yet carries an id that render
      // does not match, so it recolours that block in place and keeps every
      // other block's DOM (selection, file links, images, disclosures).
      const blocks = renderMarkdownBlocksSync(text, streaming, imageMode, rawHtml);
      let hasMermaidBlock = false;
      for (const renderedBlock of blocks) {
        const block = document.createElement('div');
        block.setAttribute('data-md-block', '');
        block.style.display = 'contents';
        block.innerHTML = renderedBlock.html;
        decorateMarkdown(block, ctx);
        block.setAttribute('data-md-id', renderedBlock.id);
        block.setAttribute(MARKDOWN_DECORATION_ID_ATTR, decorationId);
        hasMermaidBlock ||= shouldRefreshMermaidViewers(block);
        target.appendChild(block);
      }
      if (hasMermaidBlock) refreshMermaidViewers();
      markLastMarkdownBlock(target);
      // The first paint is shown as it is, without waiting for highlighting,
      // so it must already have its final geometry. Code blocks do: the
      // highlight pass only colours their lines. Tables get their measured
      // column widths here, before the browser paints this commit.
      if (tableLayoutSettled) layoutTablesNow();
    } else if (!mermaidViewerRef.current && shouldRefreshMermaidViewers(target)) {
      // StrictMode re-runs this setup after the cleanup probe. The DOM remains,
      // but the viewer registry does not, so recreate it without reinstalling
      // or re-decorating ordinary blocks.
      refreshMermaidViewers();
    }
  }, [containerRef, text, streaming, imageMode, rawHtml, ctx, refreshMermaidViewers, tableLayoutSettled, layoutTablesNow]);

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
      const cachedBlocks = getCachedMarkdownBlocks(text, imageMode, rawHtml);
      if (cachedBlocks && domMatchesRenderedBlocks(target, cachedBlocks, decorationId)) {
        mountedDomRef.current = domCacheKey
          ? { key: domCacheKey, copiedLabel: ctx.labels.copied }
          : null;
        streamPerfCount('ui.markdown_renderer.settled_paint.reused');
        scheduleTableLayout();
        return;
      }
    }

    void renderMarkdownBlocks(text, streaming, imageMode, rawHtml).then((blocks) => {
      if (!active || renderRevisionRef.current !== renderRevision) return;
      const existing = Array.from(target.children) as HTMLElement[];
      // Reconciling against freshly parsed HTML drops the measured column
      // widths of tables already on screen (the first paint lays them out).
      const resetsMeasuredTables = tableLayoutSettled
        && target.querySelector('table[data-md-table-layout="fixed"]') !== null;
      // Capture before block reconciliation: streaming completion changes the
      // wrapper layout, and theme changes can replace entire decorated blocks.
      // Match by disclosure order plus heading so unrelated replacements cannot
      // inherit the previous disclosure's state. No persistent/global state.
      const disclosureStates = Array.from(target.querySelectorAll<HTMLDetailsElement>('details[data-md-details]'))
        .map((details) => ({ summary: details.querySelector('summary')?.textContent, open: details.open }));

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

        // A code fence still streaming: keep the lines already painted and
        // add the new ones instead of rebuilding and diffing the whole block.
        const paintedId = el.getAttribute('data-md-id');
        const patch = paintedId && el.getAttribute(MARKDOWN_DECORATION_ID_ATTR) === decorationId
          ? block.patchFrom?.(paintedId)
          : null;
        if (patch && applyOpenFencePatch(el, patch)) {
          clearPatchedBlockEnterAnimation(el);
          el.setAttribute('data-md-id', block.id);
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
          onBeforeElUpdated: (fromEl, toEl) => {
            if (fromEl.matches('details[data-md-details]') && toEl.matches('details[data-md-details]')
              && fromEl.querySelector('summary')?.textContent === toEl.querySelector('summary')?.textContent) {
              toEl.toggleAttribute('open', fromEl.hasAttribute('open'));
            }
            return !fromEl.isEqualNode(toEl);
          },
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
      markLastMarkdownBlock(target);
      if (removedMermaidBlock || (existing.length > blocks.length && hadMermaidBeforeTrailingCleanup)) {
        refreshMermaidViewers();
      }
      if (disclosureStates.length > 0) {
        target.querySelectorAll<HTMLDetailsElement>('details[data-md-details]').forEach((details, index) => {
          const previous = disclosureStates[index];
          if (previous && previous.summary === details.querySelector('summary')?.textContent) {
            details.open = previous.open;
          }
        });
      }
      mountedDomRef.current = domCacheKey
        ? { key: domCacheKey, copiedLabel: ctx.labels.copied }
        : null;
      if (resetsMeasuredTables) layoutTablesNow();
      else scheduleTableLayout();
    });

    return () => {
      active = false;
    };
  }, [containerRef, ctx, domCacheKey, imageMode, rawHtml, refreshMermaidViewers, layoutTablesNow, scheduleTableLayout, streaming, tableLayoutSettled, text]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    return attachMarkdownInteractions(container, ctx);
  }, [containerRef, ctx]);
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
  useLinkInteractions({ containerRef, directory: effectiveDirectory });
  useMarkdownVideoFallback(containerRef);

  const syntaxVars = React.useMemo(() => getMarkdownSyntaxVars(currentTheme), [currentTheme]);
  // With links opening in the browser panel anyway, the preview button next to
  // a local address would only repeat the link.
  const openLinksInBrowserPanel = useUIStore((state) => state.openLinksInBrowserPanel) && isDesktopShell();
  const ctx = useDecorateContext(currentTheme, effectiveDirectory && !openLinksInBrowserPanel ? handlePreviewLoopback : undefined, DEFAULT_MERMAID_CONTROLS);
  const { locale } = useI18n();
  // Assistant images render as labels that useInlineMarkdownImages replaces
  // with the pictures once the part settles; tool output and reasoning draw
  // local images and link remote ones (see MarkdownImageMode).
  const imageMode: MarkdownImageMode = variant === 'assistant' ? 'label' : 'local';
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
    streaming: isStreaming,
    imageMode,
    syntaxVars,
    ctx,
    domCacheKey,
    tableLayoutSettled: !isStreaming,
  });

  useInlineMarkdownImages({
    containerRef,
    sessionId: imageMode === 'label' && !isStreaming ? settledSessionID : undefined,
    messageId: settledMessageID,
    directory: effectiveDirectory,
    onShowPopup,
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
  /** A leading frontmatter block: `hide` drops it, `properties` shows it above the body. Without it the block renders as Markdown. */
  frontmatter?: 'hide' | 'properties';
  onShowPopup?: (content: ToolPopupContent) => void;
  mermaidControls?: MermaidControlOptions;
  allowMermaidWheelEvents?: boolean;
  enableFileReferences?: boolean;
  /** Render the document's raw HTML through the allowlist; only for documents a user opens to read. */
  allowRawHtml?: boolean;
}> = ({
  content,
  className,
  variant = 'assistant',
  disableLinkSafety,
  frontmatter: frontmatterMode,
  onShowPopup,
  mermaidControls = DEFAULT_MERMAID_CONTROLS,
  allowMermaidWheelEvents = false,
  enableFileReferences = true,
  allowRawHtml = false,
}) => {
  const { editor, runtime } = useRuntimeAPIs();
  const currentTheme = useCurrentMermaidTheme();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const effectiveDirectory = useEffectiveDirectory() ?? '';

  const { frontmatter, body: renderedContent } = React.useMemo(
    () => (frontmatterMode ? splitFrontmatter(content) : { frontmatter: null, body: content }),
    [content, frontmatterMode],
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
  useLinkInteractions({ containerRef, enabled: !disableLinkSafety, directory: effectiveDirectory });
  useMarkdownVideoFallback(containerRef);

  const syntaxVars = React.useMemo(() => getMarkdownSyntaxVars(currentTheme), [currentTheme]);
  const ctx = useDecorateContext(currentTheme, undefined, mermaidControls);

  useMorphdomMarkdown({
    containerRef,
    text: renderedContent,
    streaming: false,
    // A document a user opened (allowRawHtml) draws its images like GitHub
    // does; everything else here is written by a model or a tool.
    imageMode: 'local',
    rawHtml: allowRawHtml ? 'sanitize' : 'escape',
    syntaxVars,
    ctx,
    tableLayoutSettled: true,
  });

  return (
    <div className={cn('break-words w-full min-w-0', className)} ref={containerRef}>
      {frontmatterMode === 'properties' && frontmatter ? <FrontmatterProperties frontmatter={frontmatter} /> : null}
      <div className={markdownContentClassName(variant)} data-markdown-content data-markdown-html={allowRawHtml ? '' : undefined} />
    </div>
  );
};

/** @public Consumed as a named export by the lazy Markdown renderer loader. */
export const SimpleMarkdownRenderer = React.memo(SimpleMarkdownRendererImpl, (prev, next) => {
  const prevMermaidControls = prev.mermaidControls ?? DEFAULT_MERMAID_CONTROLS;
  const nextMermaidControls = next.mermaidControls ?? DEFAULT_MERMAID_CONTROLS;

  return prev.content === next.content
    && prev.variant === next.variant
    && prev.className === next.className
    && prev.disableLinkSafety === next.disableLinkSafety
    && prev.frontmatter === next.frontmatter
    && prev.onShowPopup === next.onShowPopup
    && prevMermaidControls.download === nextMermaidControls.download
    && prevMermaidControls.copy === nextMermaidControls.copy
    && prevMermaidControls.showPanZoomControls === nextMermaidControls.showPanZoomControls
    && prev.allowMermaidWheelEvents === next.allowMermaidWheelEvents
    && prev.enableFileReferences === next.enableFileReferences
    && prev.allowRawHtml === next.allowRawHtml;
});
