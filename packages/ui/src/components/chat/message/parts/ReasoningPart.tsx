import React from 'react';
import { animate, type AnimationPlaybackControls } from 'motion';
import type { Part } from '@/lib/opencode/model';
import { cn } from '@/lib/utils';
import { isInvisibleText } from '@/lib/invisibleText';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { BusyDots } from '@/components/ui/busy-dots';
import { BlockBody } from './BlockLine';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { MarkdownRenderer } from '../../MarkdownRenderer';
import type { MarkdownVariant } from '../../MarkdownRendererImpl';
import { useStreamingTextThrottle } from '../../hooks/useStreamingTextThrottle';
import type { StreamPhase } from '../types';
import { useReasoningReveal } from '@/components/chat/search/reasoningReveal';
import { dispatchRowExpand } from '@/components/chat/lib/scroll/timelineScrollIntent';

const TOOL_ROW_TEXT_CLASS = '!text-[length:var(--text-meta)] !leading-5 sm:!leading-6 tracking-normal';
const TOOL_ROW_TITLE_CLASS = cn('typography-meta font-normal', TOOL_ROW_TEXT_CLASS);
const TOOL_ROW_DESCRIPTION_CLASS = cn('typography-meta', TOOL_ROW_TEXT_CLASS);

type PartWithText = Part & { text?: string; content?: string; time?: { start?: number; end?: number } };

const cleanReasoningText = (text: string): string => {
    if (typeof text !== 'string' || isInvisibleText(text)) {
        return '';
    }

    return text
        .split('\n')
        .map((line: string) => line.replace(/^>\s?/, '').trimEnd())
        .filter((line: string) => !isInvisibleText(line))
        .join('\n')
        .trim();
};

const SUMMARY_MAX_CHARS = 400;
const SUMMARY_SOURCE_CHARS = 4000;
const EXPANDED_CONTENT_UNMOUNT_DELAY_MS = 200;
const EXPANDED_CONTENT_TRANSITION = { duration: 0.2, ease: 'easeOut' as const };

const stripMarkdown = (text: string): string =>
    text
        .replace(/<!--\s*-->/g, '')
        .replace(/```[\w]*\n?([\s\S]*?)```/g, (_, inner: string) => inner.trim())
        .replace(/```[\w]*\n?/g, '')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
        .replace(/_{1,3}([^_]+)_{1,3}/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^>\s?/gm, '')
        .replace(/^[-*_]{3,}\s*$/gm, '')
        .trim();

const getReasoningSummary = (text: string): string => {
    if (!text) {
        return '';
    }

    const cutShort = text.length > SUMMARY_SOURCE_CHARS;
    const source = cutShort ? text.slice(0, SUMMARY_SOURCE_CHARS) : text;
    const flat = stripMarkdown(source).replace(/\s+/g, ' ').trim();

    if (flat.length <= SUMMARY_MAX_CHARS) {
        return cutShort && flat ? `${flat}…` : flat;
    }

    const cut = flat.lastIndexOf(' ', SUMMARY_MAX_CHARS);
    const end = cut > 0 ? cut : SUMMARY_MAX_CHARS;
    return `${flat.substring(0, end).trimEnd()}…`;
};

type ReasoningTimelineBlockProps = {
    text: string;
    blockId: string;
    time?: { start?: number; end?: number };
    isStreaming?: boolean;
    actions?: React.ReactNode;
    defaultExpanded?: boolean;
    expandWhileStreaming?: boolean;
    revealRequest?: number;
    reasoningMessageId?: string;
    presentation?: {
        icon: IconName;
        iconClassName?: string;
        title: React.ReactNode;
        expandLabel: string;
        collapseLabel: string;
        markdownVariant: MarkdownVariant;
        maxHeightClassName: string;
    };
};

type ExpansionState = {
    expanded: boolean;
    source: 'auto' | 'user';
};

export const ReasoningTimelineBlock: React.FC<ReasoningTimelineBlockProps> = ({
    text,
    blockId,
    time,
    isStreaming = false,
    actions,
    defaultExpanded,
    expandWhileStreaming = true,
    revealRequest = 0,
    reasoningMessageId,
    presentation,
}) => {
    const { t } = useI18n();
    const hasEnded = typeof time?.end === 'number';
    const canAutoExpand = expandWhileStreaming && isStreaming && !hasEnded;
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
    const [handledReveal, setHandledReveal] = React.useState(0);
    if (revealRequest !== 0 && revealRequest !== handledReveal) {
        setHandledReveal(revealRequest);
        setExpansion({ expanded: true, source: 'user' });
        setShouldRenderExpandedContent(true);
    }
    const contentId = React.useId();
    const contentRef = React.useRef<HTMLDivElement>(null);
    const contentAnimationRef = React.useRef<AnimationPlaybackControls | null>(null);
    const contentMountedRef = React.useRef(false);

    const scrollBoxRef = React.useRef<HTMLElement | null>(null);
    const followBoxEndRef = React.useRef(true);
    const lastBoxScrollTopRef = React.useRef(0);
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
        if (touch.clientY > startY + 4) releaseBoxFollow();
    }, [releaseBoxFollow]);
    const handleBoxScroll = React.useCallback((event: React.UIEvent<HTMLElement>) => {
        const node = event.currentTarget;
        const distanceToEnd = node.scrollHeight - node.clientHeight - node.scrollTop;
        if (distanceToEnd <= 2) {
            followBoxEndRef.current = true;
        } else if (node.scrollTop < lastBoxScrollTopRef.current - 1) {
            followBoxEndRef.current = false;
        }
        lastBoxScrollTopRef.current = node.scrollTop;
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
            lastBoxScrollTopRef.current = node.scrollTop;
        };
        const observer = new ResizeObserver(follow);
        observer.observe(content);
        follow();
        return () => observer.disconnect();
    }, [isStreaming, shouldRenderExpandedContent]);

    const summary = React.useMemo(() => (isStreaming ? '' : getReasoningSummary(text)), [isStreaming, text]);
    const toggleAriaLabel = isExpanded
        ? presentation?.collapseLabel ?? t('chat.reasoningTrace.collapseAria')
        : presentation?.expandLabel ?? t('chat.reasoningTrace.expandAria');
    const title = presentation?.title ?? t('chat.reasoningTrace.thinking');

    const rowRef = React.useRef<HTMLDivElement>(null);
    const handleToggle = React.useCallback(() => {
        if (!isExpanded) dispatchRowExpand(rowRef.current);
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

    if (!isStreaming && isInvisibleText(text)) {
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
                    variant={presentation?.markdownVariant ?? 'reasoning'}
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
        <div ref={rowRef} data-reasoning-block-id={blockId} data-reasoning-message-id={reasoningMessageId} data-message-text-export-root="true">
            <div
                role="button"
                tabIndex={0}
                aria-expanded={isExpanded}
                aria-controls={contentId}
                aria-label={toggleAriaLabel}
                className={cn(
                    'group/tool flex gap-1.5 pe-2 ps-px py-1.5 sm:py-1 rounded-xl cursor-pointer items-center',
                )}
                onClick={handleToggle}
                onKeyDown={handleKeyDown}
            >
                <div className={cn('flex items-center gap-1.5', presentation ? 'min-w-0 max-w-full' : 'flex-shrink-0')}>
                    <div className="relative h-3.5 w-3.5 flex-shrink-0 cursor-pointer">
                        <div
                            className={cn(
                                'absolute inset-0 transition-opacity',
                                isExpanded && 'opacity-0',
                                !isExpanded && 'group-hover/tool:opacity-0',
                            )}
                            style={{ color: 'var(--tools-icon)' }}
                        >
                            <Icon name={presentation?.icon ?? 'brain-ai-3'} className={cn('h-3.5 w-3.5', presentation?.iconClassName)} />
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
                        <span className={cn('flex items-center gap-1', TOOL_ROW_TITLE_CLASS)} style={{ color: 'var(--tools-description)' }}>
                            <span>{title}</span>
                            <BusyDots />
                        </span>
                    ) : (
                        <span
                            className={TOOL_ROW_TITLE_CLASS}
                            style={{ color: 'var(--tools-description)' }}
                        >
                            {title}
                        </span>
                    )}
                </div>

                <div className={cn('flex items-center gap-1 flex-1 min-w-0', TOOL_ROW_DESCRIPTION_CLASS)} style={{ color: 'var(--tools-description)' }}>
                    {!isStreaming && !isExpanded && summary ? (
                        <span
                            className={cn('min-w-0 truncate', TOOL_ROW_DESCRIPTION_CLASS)}
                            style={{ color: 'var(--tools-description)' }}
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
                    <BlockBody
                        onToggle={handleToggle}
                        style={{
                            opacity: isExpanded ? 1 : 0,
                            transform: isExpanded ? 'translateY(0)' : 'translateY(-4px)',
                            transition: 'opacity 180ms ease-out, transform 180ms ease-out',
                        }}
                    >
                        <ScrollableOverlay
                            ref={scrollBoxRef}
                            as="div"
                            outerClassName={presentation?.maxHeightClassName ?? 'max-h-80'}
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
                    </BlockBody>
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
    const expandWhileStreaming = useUIStore((state) => state.expandReasoningWhileStreaming);
    const revealRequest = useReasoningReveal(messageId);
    const partWithText = part as PartWithText;
    const rawText = partWithText.text || partWithText.content || '';
    const textContent = React.useMemo(() => cleanReasoningText(rawText), [rawText]);
    const time = partWithText.time;
    // external: #2020 Cached reasoning without time.end is not evidence of live streaming.
    const isLiveStreamPhase = streamPhase === 'streaming' || streamPhase === 'cooldown';
    const isStreaming = isLiveStreamPhase && typeof time?.end !== 'number';
    const throttledText = useStreamingTextThrottle({
        text: textContent,
        isStreaming,
        identityKey: `${messageId}:${part.id ?? 'reasoning'}`,
    });
    if (!isStreaming && isInvisibleText(throttledText)) {
        return null;
    }

    return (
        <ReasoningTimelineBlock
            text={throttledText}
            blockId={part.id || `${messageId}-reasoning`}
            time={time}
            isStreaming={isStreaming}
            expandWhileStreaming={expandWhileStreaming}
            revealRequest={revealRequest}
            reasoningMessageId={messageId}
        />
    );
});

export default ReasoningPart;
