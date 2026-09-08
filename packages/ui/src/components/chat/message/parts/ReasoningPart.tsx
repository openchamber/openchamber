import React from 'react';
import { animate, type AnimationPlaybackControls } from 'motion';
import type { Part } from '@opencode-ai/sdk/v2';
import { cn } from '@/lib/utils';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Icon } from '@/components/icon/Icon';
import { BusyDots } from './BusyDots';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { MarkdownRenderer } from '../../MarkdownRenderer';
import { useStreamingTextThrottle } from '../../hooks/useStreamingTextThrottle';
import { commitStreamedText } from '../../lib/streamTextCommit';
import type { StreamPhase } from '../types';

const TOOL_ROW_TEXT_CLASS = '!text-[length:var(--text-meta)] !leading-5 sm:!leading-6 tracking-normal';
const TOOL_ROW_TITLE_CLASS = cn('typography-meta font-medium', TOOL_ROW_TEXT_CLASS);
const TOOL_ROW_DESCRIPTION_CLASS = cn('typography-meta', TOOL_ROW_TEXT_CLASS);

type PartWithText = Part & { text?: string; content?: string; time?: { start?: number; end?: number } };

type ReasoningVariant = 'thinking' | 'justification';

const cleanReasoningText = (text: string): string => {
    if (typeof text !== 'string' || text.trim().length === 0) {
        return '';
    }

    return text
        .split('\n')
        .map((line: string) => line.replace(/^>\s?/, '').trimEnd())
        .filter((line: string) => line.trim().length > 0)
        .join('\n')
        .trim();
};

const SUMMARY_MAX_CHARS = 80;
const EXPANDED_CONTENT_UNMOUNT_DELAY_MS = 200;
const EXPANDED_CONTENT_TRANSITION = { duration: 0.2, ease: 'easeOut' as const };

/** Strip common markdown syntax so the header preview reads as plain text. */
const stripMarkdown = (text: string): string =>
    text
        // Empty HTML comments are frequently appended by model tool wrappers.
        .replace(/<!--\s*-->/g, '')
        // Fenced code blocks → keep inner text on one line
        .replace(/```[\w]*\n?([\s\S]*?)```/g, (_, inner: string) => inner.trim())
        // Inline code
        .replace(/`([^`]+)`/g, '$1')
        // Bold + italic (*** / __)
        .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
        .replace(/_{1,3}([^_]+)_{1,3}/g, '$1')
        // Headings (# ## ###)
        .replace(/^#{1,6}\s+/gm, '')
        // Links [label](url) → label
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        // Blockquote markers
        .replace(/^>\s?/gm, '')
        // Horizontal rules
        .replace(/^[-*_]{3,}\s*$/gm, '')
        // Remaining leading/trailing punctuation from stripped markers
        .trim();

const getReasoningSummary = (text: string): string => {
    if (!text) {
        return '';
    }

    // Strip markdown, then collapse all whitespace runs into single spaces.
    const flat = stripMarkdown(text).replace(/\s+/g, ' ').trim();

    if (flat.length <= SUMMARY_MAX_CHARS) {
        return flat;
    }

    // Cut at a word boundary before the limit, then append ellipsis.
    const cut = flat.lastIndexOf(' ', SUMMARY_MAX_CHARS);
    const end = cut > 0 ? cut : SUMMARY_MAX_CHARS;
    return `${flat.substring(0, end).trimEnd()}…`;
};

type ReasoningTimelineBlockProps = {
    text: string;
    variant: ReasoningVariant;
    blockId: string;
    time?: { start?: number; end?: number };
    showDuration?: boolean;
    isStreaming?: boolean;
    actions?: React.ReactNode;
    /** Override the initial expanded state. Defaults to `isStreaming`. */
    defaultExpanded?: boolean;
};

type ExpansionState = {
    expanded: boolean;
    source: 'auto' | 'user';
};

export const ReasoningTimelineBlock: React.FC<ReasoningTimelineBlockProps> = ({
    text,
    variant,
    blockId,
    time,
    isStreaming = false,
    actions,
    defaultExpanded,
}) => {
    const { t } = useI18n();
    const hasEnded = typeof time?.end === 'number';
    const canAutoExpand = isStreaming && !hasEnded;
    const [expansion, setExpansion] = React.useState<ExpansionState>(() => {
        if (defaultExpanded === true) {
            return { expanded: true, source: 'user' };
        }
        return { expanded: canAutoExpand, source: 'auto' };
    });
    const isExpanded = expansion.source === 'auto'
        ? canAutoExpand && expansion.expanded
        : expansion.expanded;
    const [shouldRenderExpandedContent, setShouldRenderExpandedContent] = React.useState(defaultExpanded === true || canAutoExpand);
    const contentId = React.useId();
    const contentRef = React.useRef<HTMLDivElement>(null);
    const contentAnimationRef = React.useRef<AnimationPlaybackControls | null>(null);
    const contentMountedRef = React.useRef(false);

    // The thinking body lives in a capped scroll box in every state. While it
    // streams, the box follows its own end so the newest thought stays in
    // view without growing the timeline; a wheel or drag upward inside the
    // box hands the box to the reader, and returning to its end re-arms the
    // follow. The chat's own end-follow is unaffected: the box keeps a fixed
    // height once capped, so the timeline stops growing underneath it, and an
    // upward wheel over the box scrolls the box first (it is a nested
    // scroller) and only reaches the chat once the box sits at its top.
    const scrollBoxRef = React.useRef<HTMLElement | null>(null);
    const followBoxEndRef = React.useRef(true);
    const touchStartYRef = React.useRef<number | null>(null);
    const releaseBoxFollow = React.useCallback(() => {
        followBoxEndRef.current = false;
    }, []);
    const handleBoxWheel = React.useCallback((event: React.WheelEvent<HTMLElement>) => {
        if (event.deltaY < 0) releaseBoxFollow();
    }, [releaseBoxFollow]);
    const handleBoxTouchStart = React.useCallback((event: React.TouchEvent<HTMLElement>) => {
        touchStartYRef.current = event.touches[0]?.clientY ?? null;
    }, []);
    const handleBoxTouchMove = React.useCallback((event: React.TouchEvent<HTMLElement>) => {
        const startY = touchStartYRef.current;
        const touch = event.touches[0];
        if (startY === null || !touch) return;
        // A downward finger drags the content up: the reader wants history.
        if (touch.clientY > startY + 4) releaseBoxFollow();
    }, [releaseBoxFollow]);
    const handleBoxScroll = React.useCallback((event: React.UIEvent<HTMLElement>) => {
        const node = event.currentTarget;
        const distanceToEnd = node.scrollHeight - node.clientHeight - node.scrollTop;
        followBoxEndRef.current = distanceToEnd <= 2;
    }, []);

    React.useEffect(() => {
        if (!isStreaming) return;
        followBoxEndRef.current = true;
        const node = scrollBoxRef.current;
        if (!node || !globalThis.ResizeObserver) return;
        const content = node.firstElementChild;
        if (!content) return;
        const follow = () => {
            if (!followBoxEndRef.current) return;
            const end = node.scrollHeight - node.clientHeight;
            if (end - node.scrollTop > 1) node.scrollTop = end;
        };
        // Growth lands asynchronously (markdown commits off the render pass),
        // so the content box is observed rather than the text prop.
        const observer = new ResizeObserver(follow);
        observer.observe(content);
        follow();
        return () => observer.disconnect();
    }, [isStreaming, shouldRenderExpandedContent]);

    const summary = React.useMemo(() => getReasoningSummary(text), [text]);
    const toggleAriaLabel = isExpanded
        ? t('chat.reasoningTrace.collapseAria')
        : t('chat.reasoningTrace.expandAria');

    const handleToggle = React.useCallback(() => {
        setShouldRenderExpandedContent(true);
        setExpansion({ expanded: !isExpanded, source: 'user' });
    }, [isExpanded]);

    const handleKeyDown = React.useCallback((event: React.KeyboardEvent) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleToggle();
        }
    }, [handleToggle]);

    React.useLayoutEffect(() => {
        setExpansion((prev) => {
            if (prev.source === 'user') {
                return prev;
            }
            if (prev.expanded === canAutoExpand) {
                return prev;
            }
            return { expanded: canAutoExpand, source: 'auto' };
        });
    }, [canAutoExpand]);

    React.useEffect(() => {
        if (isExpanded || isStreaming) {
            setShouldRenderExpandedContent(true);
            return;
        }

        if (!shouldRenderExpandedContent) {
            return;
        }

        if (typeof window === 'undefined') {
            setShouldRenderExpandedContent(false);
            return;
        }

        const timer = window.setTimeout(() => {
            setShouldRenderExpandedContent(false);
        }, EXPANDED_CONTENT_UNMOUNT_DELAY_MS);

        return () => {
            window.clearTimeout(timer);
        };
    }, [isExpanded, isStreaming, shouldRenderExpandedContent]);

    React.useLayoutEffect(() => {
        const element = contentRef.current;
        if (!element) {
            return;
        }

        contentAnimationRef.current?.stop();

        if (!contentMountedRef.current) {
            contentMountedRef.current = true;
            if (!isExpanded) {
                element.style.height = '0px';
                element.style.overflow = 'hidden';
                return;
            }

            element.style.height = '0px';
            element.style.overflow = 'hidden';

            const animation = animate(
                element,
                { height: 'auto' },
                EXPANDED_CONTENT_TRANSITION,
            );
            contentAnimationRef.current = animation;

            void animation.finished.then(() => {
                if (contentAnimationRef.current !== animation) {
                    return;
                }
                contentAnimationRef.current = null;
                element.style.overflow = 'visible';
                element.style.height = 'auto';
            }).catch(() => undefined);

            return () => {
                animation.stop();
                if (contentAnimationRef.current === animation) {
                    contentAnimationRef.current = null;
                }
            };
        }

        element.style.overflow = 'hidden';

        if (isExpanded) {
            element.style.height = '0px';
        } else {
            element.style.height = `${element.scrollHeight}px`;
        }

        const animation = animate(
            element,
            { height: isExpanded ? 'auto' : '0px' },
            EXPANDED_CONTENT_TRANSITION,
        );
        contentAnimationRef.current = animation;

        void animation.finished.then(() => {
            if (contentAnimationRef.current !== animation) {
                return;
            }
            contentAnimationRef.current = null;
            if (isExpanded) {
                element.style.overflow = 'visible';
                element.style.height = 'auto';
            } else {
                element.style.overflow = 'hidden';
            }
        }).catch(() => undefined);

        return () => {
            animation.stop();
            if (contentAnimationRef.current === animation) {
                contentAnimationRef.current = null;
            }
        };
    }, [isExpanded]);

    React.useEffect(() => {
        return () => {
            contentAnimationRef.current?.stop();
            contentAnimationRef.current = null;
        };
    }, []);

    // While genuinely streaming, the busy header must appear as soon as
    // reasoning starts even before the block-level reveal (commitStreamedText)
    // has committed a first complete line — otherwise "Thinking…" never shows
    // for the first moments of a short, single-paragraph response.
    if (!isStreaming && (!text || text.trim().length === 0)) {
        return null;
    }

    const reasoningBody = (
        <>
            <div data-message-text-export-source="true">
                <MarkdownRenderer
                    content={text}
                    messageId={blockId}
                    isAnimated={false}
                    isStreaming={isStreaming}
                    variant="reasoning"
                />
            </div>
            {actions ? (
                <div className="mt-2 mb-1 flex items-center justify-start gap-1.5" data-message-actions="true">
                    <div className="flex items-center gap-1.5" data-message-action-group="true">
                        {actions}
                    </div>
                </div>
            ) : null}
        </>
    );

    return (
        <div data-reasoning-block-id={blockId} data-message-text-export-root="true">
            <div
                role="button"
                tabIndex={0}
                aria-expanded={isExpanded}
                aria-controls={contentId}
                aria-label={toggleAriaLabel}
                className={cn(
                    'group/tool flex gap-1.5 pr-2 pl-px py-1.5 rounded-xl cursor-pointer items-center',
                )}
                onClick={handleToggle}
                onKeyDown={handleKeyDown}
            >
                <div className="flex items-center gap-1.5 flex-shrink-0">
                    <div className="relative h-3.5 w-3.5 flex-shrink-0 cursor-pointer">
                        <div
                            className={cn(
                                'absolute inset-0 transition-opacity',
                                isExpanded && 'opacity-0',
                                !isExpanded && 'group-hover/tool:opacity-0',
                            )}
                            style={{ color: 'var(--tools-icon)' }}
                        >
                            <Icon name="brain-ai-3" className="h-3.5 w-3.5" />
                        </div>
                        <div
                            className={cn(
                                'absolute inset-0 transition-opacity flex items-center justify-center',
                                isExpanded && 'opacity-100',
                                !isExpanded && 'opacity-0 group-hover/tool:opacity-100',
                            )}
                            style={{ color: 'var(--tools-icon)' }}
                        >
                            {isExpanded ? <Icon name="arrow-down-s" className="h-3.5 w-3.5" /> : <Icon name="arrow-right-s" className="h-3.5 w-3.5" />}
                        </div>
                    </div>

                    {isStreaming ? (
                        <span className={cn('flex items-center gap-1', TOOL_ROW_TITLE_CLASS)} style={{ color: 'var(--tools-title)' }}>
                            <span>{t(variant === 'justification' ? 'chat.reasoningTrace.justification' : 'chat.reasoningTrace.thinking')}</span>
                            <BusyDots />
                        </span>
                    ) : isExpanded ? (
                        <span
                            className={TOOL_ROW_TITLE_CLASS}
                            style={{ color: 'var(--tools-title)' }}
                        >
                            {t(variant === 'justification' ? 'chat.reasoningTrace.justification' : 'chat.reasoningTrace.thinking')}
                        </span>
                    ) : (
                        <span
                            className={TOOL_ROW_TITLE_CLASS}
                            style={{ color: 'var(--tools-title)' }}
                        >
                            {t(variant === 'justification' ? 'chat.reasoningTrace.justification' : 'chat.reasoningTrace.thinking')}
                        </span>
                    )}
                </div>

                <div className={cn('flex items-center gap-1 flex-1 min-w-0', TOOL_ROW_DESCRIPTION_CLASS)} style={{ color: 'var(--tools-description)' }}>
                    {!isStreaming && !isExpanded && summary ? (
                        <span
                            className={cn('min-w-0 truncate', TOOL_ROW_DESCRIPTION_CLASS)}
                            style={{ color: 'var(--tools-description)', opacity: 0.8 }}
                            title={summary}
                        >
                            {summary}
                        </span>
                    ) : (
                        <span className="min-w-0 flex-1" />
                    )}
                </div>
            </div>

            {shouldRenderExpandedContent ? (
                <div
                    ref={contentRef}
                    id={contentId}
                    aria-hidden={!isExpanded}
                    style={{
                        height: isExpanded ? 'auto' : '0px',
                        overflow: isExpanded ? 'visible' : 'hidden',
                        overflowAnchor: 'none',
                    }}
                >
                    <div
                        className="relative ml-2 pl-3 pb-1 pt-0.5"
                        style={{
                            opacity: isExpanded ? 1 : 0,
                            transform: isExpanded ? 'translateY(0)' : 'translateY(-4px)',
                            transition: 'opacity 180ms ease-out, transform 180ms ease-out',
                        }}
                    >
                        <span
                            aria-hidden="true"
                            className="pointer-events-none absolute left-0 top-0 bottom-0 w-px"
                            style={{ backgroundColor: 'var(--tools-border)' }}
                        />
                        <ScrollableOverlay
                            ref={scrollBoxRef}
                            as="div"
                            outerClassName="max-h-80"
                            className="p-0"
                            useScrollShadow
                            scrollShadowSize={36}
                            userIntentOnly
                            data-scrollable="true"
                            onWheel={handleBoxWheel}
                            onTouchStart={handleBoxTouchStart}
                            onTouchMove={handleBoxTouchMove}
                            onScroll={handleBoxScroll}
                        >
                            <div>{reasoningBody}</div>
                        </ScrollableOverlay>
                    </div>
                </div>
            ) : null}
        </div>
    );
};

type ReasoningPartProps = {
    part: Part;
    messageId: string;
    streamPhase?: StreamPhase;
};

const ReasoningPart = React.memo(({
    part,
    messageId,
    streamPhase,
}: ReasoningPartProps) => {
    const chatRenderMode = useUIStore((state) => state.chatRenderMode);
    const partWithText = part as PartWithText;
    const rawText = partWithText.text || partWithText.content || '';
    const textContent = React.useMemo(() => cleanReasoningText(rawText), [rawText]);
    const time = partWithText.time;
    // Live activity derives from the live stream phase, never from the absence
    // of persisted timing data: cached parts may lack `time.end` even though
    // the message finished long ago (issue #2020). A part that has ended is
    // never streaming, even while the rest of the message still streams.
    const isLiveStreamPhase = streamPhase === 'streaming' || streamPhase === 'cooldown';
    const isStreaming = chatRenderMode === 'live' && isLiveStreamPhase && typeof time?.end !== 'number';
    const throttledTextRaw = useStreamingTextThrottle({
        text: textContent,
        isStreaming,
        identityKey: `${messageId}:${part.id ?? 'reasoning'}`,
    });
    // Same block-level reveal as assistant text: a shown reasoning paragraph
    // never mutates in place.
    const throttledText = isStreaming ? commitStreamedText(throttledTextRaw) : throttledTextRaw;

    // Show reasoning even if time.end isn't set yet (during streaming).
    // While genuinely streaming, keep the block mounted even before the
    // block-level reveal commits a first line, so the busy header appears
    // immediately instead of waiting on committed text.
    if (!isStreaming && (!throttledText || throttledText.trim().length === 0)) {
        return null;
    }

    return (
        <ReasoningTimelineBlock
            text={throttledText}
            variant="thinking"
            blockId={part.id || `${messageId}-reasoning`}
            time={time}
            isStreaming={isStreaming}
        />
    );
});

export default ReasoningPart;
