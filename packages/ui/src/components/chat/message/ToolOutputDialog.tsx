import React from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { RiArrowLeftSLine, RiArrowRightSLine, RiBrainAi3Line, RiCloseLine, RiFileImageLine, RiFileList2Line, RiFilePdfLine, RiFileSearchLine, RiFolder6Line, RiGitBranchLine, RiGlobalLine, RiListCheck3, RiLoader4Line, RiPencilAiLine, RiSearchLine, RiTaskLine, RiTerminalBoxLine, RiToolsLine } from '@remixicon/react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/utils';
import { SimpleMarkdownRenderer } from '../MarkdownRenderer';
import { toolDisplayStyles } from '@/lib/typography';
import { getLanguageFromExtension } from '@/lib/toolHelpers';
import {
    renderTodoOutput,
    renderListOutput,
    renderGrepOutput,
    renderGlobOutput,
    renderWebSearchOutput,
    formatInputForDisplay,
    parseDiffToUnified,
    parseReadToolOutput,
    type UnifiedDiffHunk,
    type SideBySideDiffHunk,
    type SideBySideDiffLine,
} from './toolRenderers';
import type { ToolPopupContent, DiffViewMode } from './types';
import { DiffViewToggle } from './DiffViewToggle';
import { VirtualizedCodeBlock, type CodeLine } from './parts/VirtualizedCodeBlock';

interface ToolOutputDialogProps {
    popup: ToolPopupContent;
    onOpenChange: (open: boolean) => void;
    syntaxTheme: { [key: string]: React.CSSProperties };
    isMobile: boolean;
}

const getToolIcon = (toolName: string) => {
    const iconClass = 'h-3.5 w-3.5 flex-shrink-0';
    const tool = toolName.toLowerCase();

    if (tool === 'reasoning') {
        return <RiBrainAi3Line className={iconClass} />;
    }
    if (tool === 'image-preview') {
        return <RiFileImageLine className={iconClass} />;
    }
    if (tool === 'mermaid-preview') {
        return <RiFileList2Line className={iconClass} />;
    }
    if (tool === 'edit' || tool === 'multiedit' || tool === 'apply_patch' || tool === 'str_replace' || tool === 'str_replace_based_edit_tool') {
        return <RiPencilAiLine className={iconClass} />;
    }
    if (tool === 'write' || tool === 'create' || tool === 'file_write') {
        return <RiFilePdfLine className={iconClass} />;
    }
    if (tool === 'read' || tool === 'view' || tool === 'file_read' || tool === 'cat') {
        return <RiFilePdfLine className={iconClass} />;
    }
    if (tool === 'bash' || tool === 'shell' || tool === 'cmd' || tool === 'terminal') {
        return <RiTerminalBoxLine className={iconClass} />;
    }
    if (tool === 'list' || tool === 'ls' || tool === 'dir' || tool === 'list_files') {
        return <RiFolder6Line className={iconClass} />;
    }
    if (tool === 'search' || tool === 'grep' || tool === 'find' || tool === 'ripgrep') {
        return <RiSearchLine className={iconClass} />;
    }
    if (tool === 'glob') {
        return <RiFileSearchLine className={iconClass} />;
    }
    if (tool === 'fetch' || tool === 'curl' || tool === 'wget' || tool === 'webfetch') {
        return <RiGlobalLine className={iconClass} />;
    }
    if (tool === 'web-search' || tool === 'websearch' || tool === 'search_web' || tool === 'google' || tool === 'bing' || tool === 'duckduckgo') {
        return <RiSearchLine className={iconClass} />;
    }
    if (tool === 'todowrite' || tool === 'todoread') {
        return <RiListCheck3 className={iconClass} />;
    }
    if (tool === 'plan_enter') {
        return <RiFileList2Line className={iconClass} />;
    }
    if (tool === 'plan_exit') {
        return <RiTaskLine className={iconClass} />;
    }
    if (tool.startsWith('git')) {
        return <RiGitBranchLine className={iconClass} />;
    }
    return <RiToolsLine className={iconClass} />;
};

const PREVIEW_ANIMATION_MS = 150;
const MERMAID_DIALOG_HEADER_HEIGHT = 40;
const MERMAID_ASPECT_RETRY_DELAY_MS = 120;
const MERMAID_ASPECT_MAX_RETRIES = 3;

type ViewportSize = { width: number; height: number };

const getWindowViewport = (): ViewportSize => ({
    width: typeof window !== 'undefined' ? window.innerWidth : 0,
    height: typeof window !== 'undefined' ? window.innerHeight : 0,
});

const PREVIEW_VIEWPORT_LIMITS = {
    mobile: { widthRatio: 0.94, heightRatio: 0.86, padding: 10 },
    desktop: { widthRatio: 0.8, heightRatio: 0.8, padding: 16 },
} as const;

const getPreviewViewportBounds = (viewport: { width: number; height: number }, isMobile: boolean) => {
    const limits = isMobile ? PREVIEW_VIEWPORT_LIMITS.mobile : PREVIEW_VIEWPORT_LIMITS.desktop;
    const paddedWidth = Math.max(160, viewport.width - limits.padding * 2);
    const paddedHeight = Math.max(160, viewport.height - limits.padding * 2);

    return {
        maxWidth: Math.max(160, Math.min(paddedWidth, viewport.width * limits.widthRatio)),
        maxHeight: Math.max(160, Math.min(paddedHeight, viewport.height * limits.heightRatio)),
    };
};

const getSvgAspectRatio = (svg: SVGElement): number | null => {
    try {
        const groups = Array.from(svg.querySelectorAll('g'));
        let bestArea = 0;
        let bestRatio: number | null = null;

        for (const group of groups) {
            if (!(group instanceof SVGGraphicsElement)) {
                continue;
            }
            const box = group.getBBox();
            if (!(box.width > 0 && box.height > 0)) {
                continue;
            }
            const area = box.width * box.height;
            if (area > bestArea) {
                bestArea = area;
                bestRatio = box.width / box.height;
            }
        }

        if (bestRatio && Number.isFinite(bestRatio) && bestRatio > 0) {
            return bestRatio;
        }
    } catch {
        // Ignore getBBox failures and fall back to SVG attrs/viewBox.
    }

    const viewBox = svg.getAttribute('viewBox');
    if (viewBox) {
        const parts = viewBox.trim().split(/\s+/).map(Number);
        if (parts.length === 4) {
            const width = parts[2];
            const height = parts[3];
            if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
                return width / height;
            }
        }
    }

    const attrWidth = Number(svg.getAttribute('width'));
    const attrHeight = Number(svg.getAttribute('height'));
    if (Number.isFinite(attrWidth) && Number.isFinite(attrHeight) && attrWidth > 0 && attrHeight > 0) {
        return attrWidth / attrHeight;
    }

    const rect = svg.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
        return rect.width / rect.height;
    }

    return null;
};

const usePreviewOverlayState = (open: boolean) => {
    const [isRendered, setIsRendered] = React.useState(open);
    const [isVisible, setIsVisible] = React.useState(open);
    const [isTransitioning, setIsTransitioning] = React.useState(false);

    React.useEffect(() => {
        if (open) {
            setIsRendered(true);
            setIsTransitioning(true);
            if (typeof window === 'undefined') {
                setIsVisible(true);
                return;
            }

            const raf = window.requestAnimationFrame(() => {
                setIsVisible(true);
            });

            const doneId = window.setTimeout(() => {
                setIsTransitioning(false);
            }, PREVIEW_ANIMATION_MS);

            return () => {
                window.cancelAnimationFrame(raf);
                window.clearTimeout(doneId);
            };
        }

        setIsVisible(false);
        setIsTransitioning(true);
        if (typeof window === 'undefined') {
            setIsRendered(false);
            return;
        }

        const timeoutId = window.setTimeout(() => {
            setIsRendered(false);
            setIsTransitioning(false);
        }, PREVIEW_ANIMATION_MS);

        return () => {
            window.clearTimeout(timeoutId);
        };
    }, [open]);

    return { isRendered, isVisible, isTransitioning };
};

const usePreviewViewport = (open: boolean) => {
    const [viewport, setViewport] = React.useState<ViewportSize>(getWindowViewport);

    React.useEffect(() => {
        if (!open || typeof window === 'undefined') {
            return;
        }

        const onResize = () => {
            setViewport(getWindowViewport());
        };

        onResize();
        window.addEventListener('resize', onResize);
        return () => {
            window.removeEventListener('resize', onResize);
        };
    }, [open]);

    return viewport;
};

const ImagePreviewDialog: React.FC<{
    popup: ToolPopupContent;
    onOpenChange: (open: boolean) => void;
    isMobile: boolean;
}> = ({ popup, onOpenChange, isMobile }) => {
    const gallery = React.useMemo(() => {
        const baseImage = popup.image;
        if (!baseImage) return [] as Array<{ url: string; mimeType?: string; filename?: string; size?: number }>;
        const fromPopup = Array.isArray(baseImage.gallery)
            ? baseImage.gallery.filter((item): item is { url: string; mimeType?: string; filename?: string; size?: number } => Boolean(item?.url))
            : [];

        if (fromPopup.length > 0) {
            return fromPopup;
        }

        return [{
            url: baseImage.url,
            mimeType: baseImage.mimeType,
            filename: baseImage.filename,
            size: baseImage.size,
        }];
    }, [popup.image]);

    const [currentIndex, setCurrentIndex] = React.useState(0);
    const [imageNaturalSize, setImageNaturalSize] = React.useState<{ width: number; height: number } | null>(null);
    const { isRendered, isVisible, isTransitioning } = usePreviewOverlayState(popup.open);
    const viewport = usePreviewViewport(popup.open);

    React.useEffect(() => {
        if (!popup.open || gallery.length === 0) {
            return;
        }

        const requestedIndex = typeof popup.image?.index === 'number' ? popup.image.index : -1;
        if (requestedIndex >= 0 && requestedIndex < gallery.length) {
            setCurrentIndex(requestedIndex);
            return;
        }

        const matchingIndex = popup.image?.url
            ? gallery.findIndex((item) => item.url === popup.image?.url)
            : -1;
        setCurrentIndex(matchingIndex >= 0 ? matchingIndex : 0);
    }, [gallery, popup.image?.index, popup.image?.url, popup.open]);

    const currentImage = gallery[currentIndex] ?? gallery[0] ?? popup.image;
    const imageTitle = currentImage?.filename || popup.title || 'Image preview';
    const hasMultipleImages = gallery.length > 1;

    const showPrevious = React.useCallback(() => {
        if (gallery.length <= 1) return;
        setCurrentIndex((prev) => (prev - 1 + gallery.length) % gallery.length);
    }, [gallery.length]);

    const showNext = React.useCallback(() => {
        if (gallery.length <= 1) return;
        setCurrentIndex((prev) => (prev + 1) % gallery.length);
    }, [gallery.length]);

    React.useEffect(() => {
        if (!popup.open) {
            return;
        }

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                onOpenChange(false);
                return;
            }

            if (event.key === 'ArrowLeft' && hasMultipleImages) {
                event.preventDefault();
                showPrevious();
                return;
            }

            if (event.key === 'ArrowRight' && hasMultipleImages) {
                event.preventDefault();
                showNext();
            }
        };

        window.addEventListener('keydown', onKeyDown);
        return () => {
            window.removeEventListener('keydown', onKeyDown);
        };
    }, [hasMultipleImages, onOpenChange, popup.open, showNext, showPrevious]);

    React.useEffect(() => {
        setImageNaturalSize(null);
    }, [currentImage?.url]);

    const imageDisplaySize = React.useMemo(() => {
        const maxWidth = Math.max(160, viewport.width * (isMobile ? 0.86 : 0.75));
        const maxHeight = Math.max(160, viewport.height * (isMobile ? 0.72 : 0.75));

        if (!imageNaturalSize) {
            return {
                width: Math.round(maxWidth),
                height: Math.round(maxHeight),
            };
        }

        const widthScale = maxWidth / imageNaturalSize.width;
        const heightScale = maxHeight / imageNaturalSize.height;
        const scale = Math.min(widthScale, heightScale);

        return {
            width: Math.max(1, Math.round(imageNaturalSize.width * scale)),
            height: Math.max(1, Math.round(imageNaturalSize.height * scale)),
        };
    }, [imageNaturalSize, isMobile, viewport.height, viewport.width]);

    if (!isRendered || !currentImage || typeof document === 'undefined') {
        return null;
    }

    const content = (
        <div className={cn('fixed inset-0 z-50', popup.open ? 'pointer-events-auto' : 'pointer-events-none')}>
            <div
                aria-hidden="true"
                className={cn(
                    'absolute inset-0 bg-black/25 backdrop-blur-md',
                    isTransitioning && 'transition-opacity duration-150 ease-out',
                    isVisible ? 'opacity-100' : 'opacity-0'
                )}
                onMouseDown={() => onOpenChange(false)}
            />

            {hasMultipleImages && (
                <>
                    <button
                        type="button"
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={showPrevious}
                        className="absolute left-3 top-1/2 -translate-y-1/2 z-10 h-10 w-10 flex items-center justify-center rounded-full bg-black/25 text-foreground/90 backdrop-blur-sm hover:bg-black/35 focus:outline-none focus:ring-2 focus:ring-primary/60"
                        aria-label="Previous image"
                    >
                        <RiArrowLeftSLine className="h-6 w-6" />
                    </button>
                    <button
                        type="button"
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={showNext}
                        className="absolute right-3 top-1/2 -translate-y-1/2 z-10 h-10 w-10 flex items-center justify-center rounded-full bg-black/25 text-foreground/90 backdrop-blur-sm hover:bg-black/35 focus:outline-none focus:ring-2 focus:ring-primary/60"
                        aria-label="Next image"
                    >
                        <RiArrowRightSLine className="h-6 w-6" />
                    </button>
                </>
            )}

            <div
                className={cn(
                    'absolute inset-0 flex items-center justify-center pointer-events-none',
                    isMobile ? 'p-2.5' : 'p-4'
                )}
            >
                <div
                    className={cn(
                        'pointer-events-auto flex flex-col gap-2',
                        isTransitioning && 'transition-opacity duration-150 ease-out',
                        isVisible ? 'opacity-100' : 'opacity-0'
                    )}
                    style={{ width: `${imageDisplaySize.width}px` }}
                >
                    <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0 flex-1 text-foreground typography-ui-header font-semibold truncate" title={imageTitle}>
                            {imageTitle}
                        </div>
                        <button
                            type="button"
                            className="h-8 w-8 flex items-center justify-center rounded-lg text-muted-foreground/80 hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/60"
                            onClick={() => onOpenChange(false)}
                            aria-label="Close image preview"
                        >
                            <RiCloseLine className="h-4 w-4" />
                        </button>
                    </div>

                    <img
                        src={currentImage.url}
                        alt={imageTitle}
                        className="block object-contain"
                        style={{ width: `${imageDisplaySize.width}px`, height: `${imageDisplaySize.height}px` }}
                        loading="lazy"
                        onLoad={(event) => {
                            const element = event.currentTarget;
                            const width = element.naturalWidth;
                            const height = element.naturalHeight;
                            if (width > 0 && height > 0) {
                                setImageNaturalSize((previous) => {
                                    if (previous && previous.width === width && previous.height === height) {
                                        return previous;
                                    }
                                    return { width, height };
                                });
                            }
                        }}
                    />
                </div>
            </div>
        </div>
    );

    return createPortal(content, document.body);
};

// ── PERF-007: Virtualised sub-components for dialog ──────────────────

const DialogUnifiedDiff: React.FC<{
    popup: ToolPopupContent;
    syntaxTheme: Record<string, React.CSSProperties>;
    isMobile: boolean;
}> = React.memo(({ popup, syntaxTheme, isMobile }) => {
    const hunks = React.useMemo(() => parseDiffToUnified(popup.content), [popup.content]);

    return (
        <div className="typography-code">
            {hunks.map((hunk, hunkIdx) => {
                const inputFile = (typeof popup.metadata?.input === 'object' && popup.metadata.input !== null)
                    ? ((popup.metadata.input as Record<string, unknown>).file_path || (popup.metadata.input as Record<string, unknown>).filePath)
                    : null;
                const fileStr = typeof inputFile === 'string' ? inputFile : '';
                const hunkFileStr = typeof hunk.file === 'string' ? hunk.file : '';
                const lang = getLanguageFromExtension(fileStr || hunkFileStr || '') || 'text';

                const codeLines: CodeLine[] = hunk.lines.map((line) => ({
                    text: line.content,
                    lineNumber: line.lineNumber || null,
                    type: line.type as CodeLine['type'],
                }));

                return (
                    <div key={hunkIdx} className="border-b border-border/20 last:border-b-0">
                        <div className={cn('bg-muted/20 px-3 py-2 font-medium text-muted-foreground border-b border-border/10 sticky top-0 z-10 break-words -mx-3', isMobile ? 'typography-micro' : 'typography-markdown')}>
                            {`${hunk.file} (line ${hunk.oldStart})`}
                        </div>
                        <VirtualizedCodeBlock
                            lines={codeLines}
                            language={lang}
                            syntaxTheme={syntaxTheme}
                            maxHeight="70vh"
                            lineStyles={(line) =>
                                line.type === 'removed'
                                    ? { backgroundColor: 'var(--tools-edit-removed-bg)', color: 'var(--tools-edit-removed)' }
                                    : line.type === 'added'
                                        ? { backgroundColor: 'var(--tools-edit-added-bg)', color: 'var(--tools-edit-added)' }
                                        : undefined
                            }
                        />
                    </div>
                );
            })}
        </div>
    );
});

DialogUnifiedDiff.displayName = 'DialogUnifiedDiff';

const DialogReadContent: React.FC<{
    popup: ToolPopupContent;
    syntaxTheme: Record<string, React.CSSProperties>;
}> = React.memo(({ popup, syntaxTheme }) => {
    const parsedReadOutput = React.useMemo(() => parseReadToolOutput(popup.content), [popup.content]);

    const codeLines: CodeLine[] = React.useMemo(() => {
        const inputMeta = popup.metadata?.input;
        const inputObj = typeof inputMeta === 'object' && inputMeta !== null ? (inputMeta as Record<string, unknown>) : {};
        const offset = typeof inputObj.offset === 'number' ? inputObj.offset : 0;
        const hasExplicitLineNumbers = parsedReadOutput.lines.some((line) => line.lineNumber !== null);
        let fallbackLineCursor = offset;

        return parsedReadOutput.lines.map((line) => {
            if (line.lineNumber !== null) {
                fallbackLineCursor = line.lineNumber;
            }
            const shouldAssignFallback =
                parsedReadOutput.type === 'file'
                && !hasExplicitLineNumbers
                && line.lineNumber === null
                && !line.isInfo;
            const effectiveLineNumber = line.lineNumber ?? (shouldAssignFallback
                ? (fallbackLineCursor += 1)
                : null);

            return {
                text: line.text,
                lineNumber: effectiveLineNumber,
                isInfo: line.isInfo,
            };
        });
    }, [parsedReadOutput, popup.metadata?.input]);

    return (
        <VirtualizedCodeBlock
            lines={codeLines}
            language={popup.language || 'text'}
            syntaxTheme={syntaxTheme}
            maxHeight="70vh"
        />
    );
});

DialogReadContent.displayName = 'DialogReadContent';
const MermaidPreviewDialog: React.FC<{
    popup: ToolPopupContent;
    onOpenChange: (open: boolean) => void;
    isMobile: boolean;
}> = ({ popup, onOpenChange, isMobile }) => {
    const [source, setSource] = React.useState<string>(popup.mermaid?.source || '');
    const [status, setStatus] = React.useState<'idle' | 'loading' | 'ready' | 'error'>(popup.mermaid?.source ? 'ready' : 'idle');
    const [errorMessage, setErrorMessage] = React.useState<string>('');
    const { isRendered, isVisible, isTransitioning } = usePreviewOverlayState(popup.open);
    const [diagramAspectRatio, setDiagramAspectRatio] = React.useState<number | null>(null);
    const viewport = usePreviewViewport(popup.open);
    const requestIdRef = React.useRef(0);
    const mermaidPreviewRef = React.useRef<HTMLDivElement | null>(null);

    const normalizeFilePath = React.useCallback((rawPath: string): string | null => {
        const input = rawPath.trim();
        if (!input.toLowerCase().startsWith('file://')) {
            return null;
        }

        const isSafeLocalPath = (path: string): boolean => {
            if (!path || /[\0\r\n]/.test(path)) {
                return false;
            }

            const normalized = path.replace(/\\/g, '/');
            const segments = normalized.split('/').filter(Boolean);
            if (segments.includes('..')) {
                return false;
            }

            if (normalized.startsWith('/')) {
                return true;
            }

            return /^[A-Za-z]:\//.test(normalized);
        };

        try {
            let pathname = decodeURIComponent(new URL(input).pathname || '');
            if (/^\/[A-Za-z]:\//.test(pathname)) {
                pathname = pathname.slice(1);
            }
            return isSafeLocalPath(pathname) ? pathname : null;
        } catch {
            const stripped = input.replace(/^file:\/\//i, '');
            try {
                const decoded = decodeURIComponent(stripped);
                return isSafeLocalPath(decoded) ? decoded : null;
            } catch {
                return isSafeLocalPath(stripped) ? stripped : null;
            }
        }
    }, []);

    const decodeDataUrl = React.useCallback((value: string): string => {
        const commaIndex = value.indexOf(',');
        if (commaIndex < 0) {
            throw new Error('Malformed data URL');
        }

        const metadata = value.slice(0, commaIndex).toLowerCase();
        const payload = value.slice(commaIndex + 1);
        if (metadata.includes(';base64')) {
            return atob(payload);
        }
        return decodeURIComponent(payload);
    }, []);

    const loadMermaidSource = React.useCallback(async () => {
        const target = popup.mermaid;
        if (!target?.url) {
            setStatus('error');
            setErrorMessage('Missing Mermaid source URL.');
            return;
        }

        if (target.source) {
            setSource(target.source);
            setStatus('ready');
            setErrorMessage('');
            return;
        }

        const requestId = requestIdRef.current + 1;
        requestIdRef.current = requestId;

        setStatus('loading');
        setErrorMessage('');

        try {
            let resolvedSource = '';
            if (target.url.startsWith('data:')) {
                resolvedSource = decodeDataUrl(target.url);
            } else if (target.url.toLowerCase().startsWith('file://')) {
                const normalizedPath = normalizeFilePath(target.url);
                if (!normalizedPath) {
                    throw new Error('Invalid local file path for Mermaid preview.');
                }
                const response = await fetch(`/api/fs/raw?path=${encodeURIComponent(normalizedPath)}`);
                if (!response.ok) {
                    throw new Error(`Failed to read diagram file (${response.status})`);
                }
                resolvedSource = await response.text();
            } else {
                const resolvedUrl = new URL(target.url, window.location.origin);
                if (resolvedUrl.protocol !== 'http:' && resolvedUrl.protocol !== 'https:') {
                    throw new Error('Unsupported Mermaid URL protocol.');
                }

                const response = await fetch(resolvedUrl.toString());
                if (!response.ok) {
                    throw new Error(`Failed to load diagram (${response.status})`);
                }
                resolvedSource = await response.text();
            }

            if (requestIdRef.current !== requestId) {
                return;
            }

            setSource(resolvedSource);
            setStatus('ready');
        } catch (error) {
            if (requestIdRef.current !== requestId) {
                return;
            }
            setStatus('error');
            setErrorMessage(error instanceof Error ? error.message : 'Unable to load Mermaid diagram.');
        }
    }, [decodeDataUrl, normalizeFilePath, popup.mermaid]);

    React.useEffect(() => {
        if (!popup.open || !popup.mermaid) {
            return;
        }
        void loadMermaidSource();
    }, [loadMermaidSource, popup.mermaid, popup.open]);

    React.useEffect(() => {
        if (!popup.open) {
            return;
        }

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                onOpenChange(false);
            }
        };

        window.addEventListener('keydown', onKeyDown);
        return () => {
            window.removeEventListener('keydown', onKeyDown);
        };
    }, [onOpenChange, popup.open]);

    React.useEffect(() => {
        if (!popup.open || status !== 'ready') {
            setDiagramAspectRatio(null);
            return;
        }

        const measureAspectRatio = () => {
            const svg = mermaidPreviewRef.current?.querySelector('svg');
            if (!svg) {
                return false;
            }

            const aspectRatio = getSvgAspectRatio(svg as SVGElement);
            if (!aspectRatio || !Number.isFinite(aspectRatio) || aspectRatio <= 0) {
                return false;
            }

            setDiagramAspectRatio((previous) => {
                if (previous && Math.abs(previous - aspectRatio) < 0.001) {
                    return previous;
                }
                return aspectRatio;
            });
            return true;
        };

        let rafId = window.requestAnimationFrame(() => {
            if (!measureAspectRatio()) {
                rafId = window.requestAnimationFrame(() => {
                    measureAspectRatio();
                });
            }
        });

        let retryCount = 0;
        let timeoutId: number | undefined;
        const scheduleRetry = () => {
            if (retryCount >= MERMAID_ASPECT_MAX_RETRIES) {
                return;
            }

            timeoutId = window.setTimeout(() => {
                retryCount += 1;
                if (!measureAspectRatio()) {
                    scheduleRetry();
                }
            }, MERMAID_ASPECT_RETRY_DELAY_MS);
        };
        scheduleRetry();

        const observer = new MutationObserver(() => {
            measureAspectRatio();
        });

        if (mermaidPreviewRef.current) {
            observer.observe(mermaidPreviewRef.current, { childList: true, subtree: true, attributes: true });
        }

        return () => {
            window.cancelAnimationFrame(rafId);
            if (typeof timeoutId === 'number') {
                window.clearTimeout(timeoutId);
            }
            observer.disconnect();
        };
    }, [popup.open, source, status]);

    const mermaidMarkdown = `\`\`\`mermaid\n${source}\n\`\`\``;

    const dialogSize = React.useMemo(() => {
        const { maxWidth, maxHeight } = getPreviewViewportBounds(viewport, isMobile);
        const availableDiagramHeight = Math.max(160, maxHeight - MERMAID_DIALOG_HEADER_HEIGHT);

        if (diagramAspectRatio && diagramAspectRatio < 1) {
            const squareSide = Math.min(maxWidth, availableDiagramHeight);
            return { width: Math.round(squareSide), height: Math.round(squareSide) };
        }

        return { width: Math.round(maxWidth), height: Math.round(availableDiagramHeight) };
    }, [diagramAspectRatio, isMobile, viewport]);

    if (!isRendered || typeof document === 'undefined') {
        return null;
    }

    const content = (
        <div className={cn('fixed inset-0 z-50', popup.open ? 'pointer-events-auto' : 'pointer-events-none')}>
            <div
                aria-hidden="true"
                className={cn(
                    'absolute inset-0 bg-black/25 backdrop-blur-md',
                    isTransitioning && 'transition-opacity duration-150 ease-out',
                    isVisible ? 'opacity-100' : 'opacity-0'
                )}
                onMouseDown={() => onOpenChange(false)}
            />

            <div
                className={cn(
                    'absolute inset-0 flex items-center justify-center pointer-events-none',
                    isMobile ? 'p-2.5' : 'p-4'
                )}
            >
                <div
                    className={cn(
                        'pointer-events-auto flex flex-col gap-2',
                        isTransitioning && 'transition-opacity duration-150 ease-out',
                        isVisible ? 'opacity-100' : 'opacity-0'
                    )}
                    style={{ width: `${dialogSize.width}px` }}
                    onMouseDown={(event) => event.stopPropagation()}
                >
                    <div className="flex items-center justify-end">
                        <button
                            type="button"
                            className="h-8 w-8 flex items-center justify-center rounded-lg text-muted-foreground/80 hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/60"
                            onClick={() => onOpenChange(false)}
                            aria-label="Close diagram preview"
                        >
                            <RiCloseLine className="h-4 w-4" />
                        </button>
                    </div>
                    <div
                        className="relative overflow-hidden"
                        style={{ height: `${dialogSize.height}px` }}
                    >
                        <div className="h-full overflow-hidden">
                            {status === 'loading' && (
                                <div className="h-full min-h-28 flex items-center justify-center gap-2 text-muted-foreground typography-meta">
                                    <RiLoader4Line className="h-4 w-4 animate-spin" />
                                    <span>Loading diagram...</span>
                                </div>
                            )}

                            {status === 'error' && (
                                <div className="rounded-xl border border-border/30 bg-muted/20 p-3 space-y-3">
                                    <p className="typography-markdown" style={{ color: 'var(--status-error)' }}>
                                        {errorMessage || 'Unable to render Mermaid diagram.'}
                                    </p>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            void loadMermaidSource();
                                        }}
                                        className="px-3 py-1.5 rounded-lg typography-meta border transition-colors hover:bg-[var(--interactive-hover)]"
                                        style={{
                                            borderColor: 'var(--interactive-border)',
                                            color: 'var(--surface-foreground)',
                                        }}
                                    >
                                        Retry
                                    </button>
                                </div>
                            )}

                            {status === 'ready' && (
                                <div ref={mermaidPreviewRef} className="h-full">
                                    <SimpleMarkdownRenderer
                                        content={mermaidMarkdown}
                                        variant="tool"
                                        allowMermaidWheelZoom
                                        className="streamdown-mermaid-fullscreen h-full [&_[data-streamdown='mermaid-block']_button]:hidden"
                                        mermaidControls={{
                                            download: false,
                                            copy: false,
                                            fullscreen: false,
                                            panZoom: true,
                                        }}
                                    />
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );

    return createPortal(content, document.body);
};

const ToolOutputDialog: React.FC<ToolOutputDialogProps> = ({ popup, onOpenChange, syntaxTheme, isMobile }) => {
    const [diffViewMode, setDiffViewMode] = React.useState<DiffViewMode>(isMobile ? 'unified' : 'side-by-side');

    if (popup.image) {
        return <ImagePreviewDialog popup={popup} onOpenChange={onOpenChange} isMobile={isMobile} />;
    }

    if (popup.mermaid) {
        return <MermaidPreviewDialog popup={popup} onOpenChange={onOpenChange} isMobile={isMobile} />;
    }

    return (
        <Dialog open={popup.open} onOpenChange={onOpenChange}>
            <DialogContent
                className={cn(
                    'overflow-hidden flex flex-col min-h-0 pt-3 pb-4 px-4 gap-1',
                    '[&>button]:top-1.5',
                    isMobile ? 'w-[95vw] max-w-[95vw]' : 'max-w-5xl',
                    isMobile ? '[&>button]:right-1' : '[&>button]:top-2.5 [&>button]:right-4'
                )}
                style={{ maxHeight: '90vh' }}
            >
                <div className="flex-shrink-0 pb-1">
                    <div className="flex items-start gap-2 text-foreground typography-ui-header font-semibold">
                        {popup.metadata?.tool ? getToolIcon(popup.metadata.tool as string) : (
                            <RiToolsLine className="h-3.5 w-3.5 text-foreground flex-shrink-0" />
                        )}
                        <span className="break-words flex-1 leading-tight">{popup.title}</span>
                        {popup.isDiff && (
                            <DiffViewToggle
                                mode={diffViewMode}
                                onModeChange={setDiffViewMode}
                                className="mr-8 flex-shrink-0"
                            />
                        )}
                    </div>
                </div>
                <div className="flex-1 min-h-0 rounded-xl border border-border/30 bg-muted/10 overflow-hidden">
                    <div className="tool-output-surface h-full max-h-[75vh] overflow-y-auto px-3 pr-4">
                        {popup.metadata?.input && typeof popup.metadata.input === 'object' &&
                            Object.keys(popup.metadata.input).length > 0 &&
                            popup.metadata?.tool !== 'todowrite' &&
                            popup.metadata?.tool !== 'todoread' &&
                            popup.metadata?.tool !== 'apply_patch' ? (() => {
                                const meta = popup.metadata!;
                                const input = meta.input as Record<string, unknown>;

                                const getInputValue = (key: string): string | null => {
                                  const val = input[key];
                                  return typeof val === 'string' ? val : (typeof val === 'number' ? String(val) : null);
                                };
                                return (
                                <div className="border-b border-border/20 p-4 -mx-3">
                                    <div className="typography-markdown font-medium text-muted-foreground mb-2 px-3">
                                        {meta.tool === 'bash'
                                            ? 'Command:'
                                            : meta.tool === 'task'
                                                ? 'Task Details:'
                                                : 'Input:'}
                                    </div>
                                    {meta.tool === 'bash' && getInputValue('command') ? (
                                        <div className="tool-input-surface bg-transparent rounded-xl border border-border/20 mx-3">
                                            <SyntaxHighlighter
                                                style={syntaxTheme}
                                                language="bash"
                                                PreTag="div"
                                                customStyle={toolDisplayStyles.getPopupStyles()}
                                                codeTagProps={{ style: { background: 'transparent', backgroundColor: 'transparent', fontSize: 'inherit' } }}
                                                wrapLongLines
                                            >
                                                {getInputValue('command')!}
                                            </SyntaxHighlighter>
                                        </div>
                                    ) : meta.tool === 'task' && getInputValue('prompt') ? (
                                        <div
                                            className="tool-input-surface bg-transparent rounded-xl border border-border/20 font-mono whitespace-pre-wrap text-foreground/90 mx-3"
                                            style={toolDisplayStyles.getPopupStyles()}
                                        >
                                            {getInputValue('description') ? `Task: ${getInputValue('description')}\n` : ''}
                                            {getInputValue('subagent_type') ? `Agent Type: ${getInputValue('subagent_type')}\n` : ''}
                                            {`Instructions:\n${getInputValue('prompt')}`}
                                        </div>
                                    ) : meta.tool === 'write' && getInputValue('content') ? (
                                        <div className="tool-input-surface bg-transparent rounded-xl border border-border/20 mx-3">
                                            <SyntaxHighlighter
                                                style={syntaxTheme}
                                                language={getLanguageFromExtension(getInputValue('filePath') || getInputValue('file_path') || '') || 'text'}
                                                PreTag="div"
                                                customStyle={toolDisplayStyles.getPopupStyles()}
                                                codeTagProps={{ style: { background: 'transparent', backgroundColor: 'transparent', fontSize: 'inherit' } }}
                                                wrapLongLines
                                            >
                                                {getInputValue('content')!}
                                            </SyntaxHighlighter>
                                        </div>
                                    ) : (
                                        <div
                                            className="tool-input-surface bg-transparent rounded-xl border border-border/20 font-mono whitespace-pre-wrap text-foreground/90 mx-3"
                                            style={toolDisplayStyles.getPopupStyles()}
                                        >
                                            {formatInputForDisplay(input, meta.tool as string)}
                                        </div>
                                    )}
                                </div>
                            );
                            })() : null}

                        {popup.isDiff ? (
                            diffViewMode === 'unified' ? (
                            <DialogUnifiedDiff popup={popup} syntaxTheme={syntaxTheme} isMobile={isMobile} />
                        ) : popup.diffHunks ? (
                            <div className="typography-code">
                                {popup.diffHunks.map((hunk, hunkIdx) => (
                                    <div key={hunkIdx} className="border-b border-border/20 last:border-b-0">
                                        <div
                                            className={cn('bg-muted/20 px-3 py-2 font-medium text-muted-foreground border-b border-border/10 sticky top-0 z-10 break-words -mx-3', isMobile ? 'typography-micro' : 'typography-markdown')}
                                        >
                                            {`${hunk.file} (line ${hunk.oldStart})`}
                                        </div>
                                        <div>
                                            {(hunk as unknown as SideBySideDiffHunk).lines.map((line: SideBySideDiffLine, lineIdx: number) => (
                                                <div key={lineIdx} className="grid grid-cols-2 divide-x divide-border/20">
                                                    <div
                                                        className={cn(
                                                            'typography-code font-mono px-3 py-0.5 overflow-hidden',
                                                            line.leftLine.type === 'context' && 'bg-transparent',
                                                            line.leftLine.type === 'empty' && 'bg-transparent'
                                                        )}
                                                        style={{
                                                            lineHeight: '1.1',
                                                            ...(line.leftLine.type === 'removed' ? { backgroundColor: 'var(--tools-edit-removed-bg)' } : {}),
                                                        }}
                                                    >
                                                        <div className="flex">
                                                            <span className="w-12 flex-shrink-0 text-right pr-3 select-none border-r mr-3 -my-0.5 py-0.5" style={{ color: 'var(--tools-edit-line-number)', borderColor: 'var(--tools-border)' }}>
                                                                {line.leftLine.lineNumber || ''}
                                                            </span>
                                                            <div className="flex-1 min-w-0">
                                                                {line.leftLine.content && (
                                                                    <SyntaxHighlighter
                                                                        style={syntaxTheme}
                                                                        language={(() => {
                                                                          const input = popup.metadata?.input;
                                                                          const inputObj = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
                                                                          const filePath = inputObj.file_path || inputObj.filePath;
                                                                          const hunkFile = (hunk as unknown as UnifiedDiffHunk).file;
                                                                          return getLanguageFromExtension(typeof filePath === 'string' ? filePath : hunkFile) || 'text';
                                                                        })()}
                                                                        PreTag="div"
                                                                        wrapLines
                                                                        wrapLongLines
                                                                        customStyle={{
                                                                            margin: 0,
                                                                            padding: 0,
                                                                            fontSize: 'inherit',
                                                                                        background: 'transparent',
                                                                                        backgroundColor: 'transparent',
                                                                            borderRadius: 0,
                                                                            overflow: 'visible',
                                                                            whiteSpace: 'pre-wrap',
                                                                            wordBreak: 'break-all',
                                                                            overflowWrap: 'anywhere',
                                                                        }}
                                                                        codeTagProps={{
                                                                            style: {
                                                                                background: 'transparent',
                                                                                backgroundColor: 'transparent',
                                                                            },
                                                                        }}
                                                                    >
                                                                        {line.leftLine.content}
                                                                    </SyntaxHighlighter>
                                                                )}
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <div
                                                        className={cn(
                                                            'typography-code font-mono px-3 py-0.5 overflow-hidden',
                                                            line.rightLine.type === 'context' && 'bg-transparent',
                                                            line.rightLine.type === 'empty' && 'bg-transparent'
                                                        )}
                                                        style={{
                                                            lineHeight: '1.1',
                                                            ...(line.rightLine.type === 'added' ? { backgroundColor: 'var(--tools-edit-added-bg)' } : {}),
                                                        }}
                                                    >
                                                        <div className="flex">
                                                            <span className="w-12 flex-shrink-0 text-right pr-3 select-none border-r mr-3 -my-0.5 py-0.5" style={{ color: 'var(--tools-edit-line-number)', borderColor: 'var(--tools-border)' }}>
                                                                {line.rightLine.lineNumber || ''}
                                                            </span>
                                                            <div className="flex-1 min-w-0">
                                                                {line.rightLine.content && (
                                                                    <SyntaxHighlighter
                                                                        style={syntaxTheme}
                                                                        language={(() => {
                                                                          const input = popup.metadata?.input;
                                                                          const inputObj = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
                                                                          const filePath = inputObj.file_path || inputObj.filePath;
                                                                          const hunkFile = (hunk as unknown as UnifiedDiffHunk).file;
                                                                          return getLanguageFromExtension(typeof filePath === 'string' ? filePath : hunkFile) || 'text';
                                                                        })()}
                                                                        PreTag="div"
                                                                        wrapLines
                                                                        wrapLongLines
                                                                        customStyle={{
                                                                            margin: 0,
                                                                            padding: 0,
                                                                            fontSize: 'inherit',
                                                                                        background: 'transparent',
                                                                                        backgroundColor: 'transparent',
                                                                            borderRadius: 0,
                                                                            overflow: 'visible',
                                                                            whiteSpace: 'pre-wrap',
                                                                            wordBreak: 'break-all',
                                                                            overflowWrap: 'anywhere',
                                                                        }}
                                                                        codeTagProps={{
                                                                            style: {
                                                                                background: 'transparent',
                                                                                backgroundColor: 'transparent',
                                                                            },
                                                                        }}
                                                                    >
                                                                        {line.rightLine.content}
                                                                    </SyntaxHighlighter>
                                                                )}
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : null
                    ) : popup.content ? (
                        <div className="p-4">
                            {(() => {
                                const tool = popup.metadata?.tool;

                                if (tool === 'todowrite' || tool === 'todoread') {
                                    return (
                                        renderTodoOutput(popup.content) || (
                                            <SyntaxHighlighter
                                                style={syntaxTheme}
                                                language="json"
                                                PreTag="div"
                                                wrapLongLines
                                                customStyle={toolDisplayStyles.getPopupContainerStyles()}
                                                codeTagProps={{ style: { background: 'transparent', backgroundColor: 'transparent', fontSize: 'inherit' } }}
                                            >
                                                {popup.content}
                                            </SyntaxHighlighter>
                                        )
                                    );
                                }

                                if (tool === 'list') {
                                    return (
                                        renderListOutput(popup.content) || (
                                            <pre className="typography-markdown bg-muted/30 p-2 rounded-xl border border-border/20 font-mono whitespace-pre-wrap">
                                                {popup.content}
                                            </pre>
                                        )
                                );
                                }

                                if (tool === 'grep') {
                                    return (
                                        renderGrepOutput(popup.content, isMobile) || (
                                            <pre className="typography-code bg-muted/30 p-2 rounded-xl border border-border/20 font-mono whitespace-pre-wrap">
                                                {popup.content}
                                            </pre>
                                        )
                                    );
                                }

                                if (tool === 'glob') {
                                    return (
                                        renderGlobOutput(popup.content, isMobile) || (
                                            <pre className="typography-code bg-muted/30 p-2 rounded-xl border border-border/20 font-mono whitespace-pre-wrap">
                                                {popup.content}
                                            </pre>
                                        )
                                    );
                                }

                                if (tool === 'task' || tool === 'reasoning') {
                                    return (
                                        <div className={tool === 'reasoning' ? "text-muted-foreground/70" : ""}>
                                            <SimpleMarkdownRenderer content={popup.content} variant="tool" />
                                        </div>
                                    );
                                }

                                if (tool === 'web-search' || tool === 'websearch' || tool === 'search_web') {
                                    return (
                                        renderWebSearchOutput(popup.content, syntaxTheme) || (
                                            <SyntaxHighlighter
                                                style={syntaxTheme}
                                                language="text"
                                                PreTag="div"
                                                wrapLongLines
                                                customStyle={toolDisplayStyles.getPopupContainerStyles()}
                                                codeTagProps={{ style: { background: 'transparent', backgroundColor: 'transparent', fontSize: 'inherit' } }}
                                            >
                                                {popup.content}
                                            </SyntaxHighlighter>
                                        )
                                    );
                                }

                                if (tool === 'read') {
                                    return <DialogReadContent popup={popup} syntaxTheme={syntaxTheme} />;
                                }

                                return (
                                    <SyntaxHighlighter
                                        style={syntaxTheme}
                                        language={popup.language || 'text'}
                                        PreTag="div"
                                        wrapLongLines
                                        customStyle={toolDisplayStyles.getPopupContainerStyles()}
                                        codeTagProps={{ style: { background: 'transparent', backgroundColor: 'transparent', fontSize: 'inherit' } }}
                                    >
                                        {popup.content}
                                    </SyntaxHighlighter>
                                );
                            })()}
                        </div>
                    ) : (
                        <div className="p-8 text-muted-foreground typography-ui-header">
                            <div className="mb-2">Command completed successfully</div>
                            <div className="typography-meta">No output was produced</div>
                        </div>
                    )}
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
};

export default ToolOutputDialog;
