import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';
import { cn } from '@/lib/utils';
import type { ContentChangeReason } from '@/hooks/useChatAutoFollow';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Icon } from '@/components/icon/Icon';
import { BusyDots } from './BusyDots';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { MarkdownRenderer } from '../../MarkdownRenderer';
import { useStreamingTextThrottle } from '../../hooks/useStreamingTextThrottle';

type PartWithText = Part & { text?: string; content?: string; time?: { start?: number; end?: number } };

export type ReasoningVariant = 'thinking' | 'justification';

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
const INLINE_THRESHOLD = 120;

/** Strip common markdown syntax so the header preview reads as plain text. */
const stripMarkdown = (text: string): string =>
    text
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
    onContentChange?: (reason?: ContentChangeReason) => void;
    blockId: string;
    time?: { start?: number; end?: number };
    showDuration?: boolean;
    isStreaming?: boolean;
    actions?: React.ReactNode;
    /** Override the initial expanded state. Defaults to `isStreaming`. */
    defaultExpanded?: boolean;
};

export const ReasoningTimelineBlock: React.FC<ReasoningTimelineBlockProps> = ({
    text,
    variant,
    onContentChange,
    blockId,
    isStreaming = false,
    actions,
    defaultExpanded,
}) => {
    const { t } = useI18n();
    const [isExpanded, setIsExpanded] = React.useState(defaultExpanded ?? isStreaming);
    const contentId = React.useId();
    const scrollRef = React.useRef<HTMLElement>(null);
    // Track previous isStreaming so the effect only collapses on true→false
    // transitions and does NOT override defaultExpanded on initial mount.
    const prevIsStreamingRef = React.useRef(isStreaming);

    const summary = React.useMemo(() => getReasoningSummary(text), [text]);
    const toggleAriaLabel = isExpanded
        ? t('chat.reasoningTrace.collapseAria')
        : t('chat.reasoningTrace.expandAria');

    const handleToggle = React.useCallback(() => {
        setIsExpanded((prev) => !prev);
        onContentChange?.('structural');
    }, [onContentChange]);

    const handleKeyDown = React.useCallback((event: React.KeyboardEvent) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleToggle();
        }
    }, [handleToggle]);

    React.useEffect(() => {
        const wasStreaming = prevIsStreamingRef.current;
        prevIsStreamingRef.current = isStreaming;
        // Auto-collapse only when streaming ends (true → false).
        // Do not fire on mount so that defaultExpanded is respected.
        if (wasStreaming && !isStreaming) {
            setIsExpanded(false);
        }
    }, [isStreaming]);

    React.useEffect(() => {
        if (text.trim().length === 0) {
            return;
        }
        onContentChange?.('structural');
    }, [onContentChange, text]);

    React.useEffect(() => {
        if (isStreaming && isExpanded && scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [text, isStreaming, isExpanded]);

    if (!text || text.trim().length === 0) {
        return null;
    }

    const isShort = !isStreaming && text.trim().length < INLINE_THRESHOLD;

    // Short blocks: render content directly without a collapsible toggle.
    if (isShort) {
        return (
            <div className="my-1" data-reasoning-block-id={blockId} data-message-text-export-root="true">
                <div data-message-text-export-source="true">
                    <MarkdownRenderer
                        content={text}
                        messageId={blockId}
                        isAnimated={false}
                        isStreaming={false}
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
            </div>
        );
    }

    return (
        <div className="my-1" data-reasoning-block-id={blockId} data-message-text-export-root="true">
            <div
                role="button"
                tabIndex={0}
                aria-expanded={isExpanded}
                aria-controls={contentId}
                aria-label={toggleAriaLabel}
                className={cn(
                    'group/tool flex gap-1.5 pr-2 pl-px py-2 rounded-xl cursor-pointer items-center',
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
                        <span className="flex items-center gap-1 typography-meta font-medium" style={{ color: 'var(--tools-title)' }}>
                            <span>{t('chat.reasoningTrace.reasoning')}</span>
                            <BusyDots />
                        </span>
                    ) : isExpanded ? (
                        <span
                            className="typography-meta font-medium"
                            style={{ color: 'var(--tools-title)' }}
                        >
                            {t(variant === 'justification' ? 'chat.reasoningTrace.justification' : 'chat.reasoningTrace.thinking')}
                        </span>
                    ) : (
                        <span
                            className="typography-meta font-medium"
                            style={{ color: 'var(--tools-title)' }}
                        >
                            {t(variant === 'justification' ? 'chat.reasoningTrace.justification' : 'chat.reasoningTrace.thinking')}
                        </span>
                    )}
                </div>

                <div className="flex items-center gap-1 flex-1 min-w-0 typography-meta" style={{ color: 'var(--tools-description)' }}>
                    {!isStreaming && !isExpanded && summary ? (
                        <span
                            className="min-w-0 truncate typography-meta"
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

            {/* Expanded content — left border matching ToolPart */}
            {isExpanded && (
                <div
                    id={contentId}
                    className="relative ml-2 pl-3 pb-1 pt-0.5"
                >
                    <span
                        aria-hidden="true"
                        className="pointer-events-none absolute left-0 top-0 bottom-0 w-px"
                        style={{ backgroundColor: 'var(--tools-border)' }}
                    />
                    <ScrollableOverlay
                        ref={scrollRef}
                        as="div"
                        outerClassName="max-h-80"
                        className="p-0"
                        useScrollShadow
                        scrollShadowSize={36}
                        userIntentOnly
                    >
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
                    </ScrollableOverlay>
                </div>
            )}
        </div>
    );
};

type ReasoningPartProps = {
    part: Part;
    onContentChange?: (reason?: ContentChangeReason) => void;
    messageId: string;
};

const ReasoningPart = React.memo(({
    part,
    onContentChange,
    messageId,
}: ReasoningPartProps) => {
    const chatRenderMode = useUIStore((state) => state.chatRenderMode);
    const partWithText = part as PartWithText;
    const rawText = partWithText.text || partWithText.content || '';
    const textContent = React.useMemo(() => cleanReasoningText(rawText), [rawText]);
    const time = partWithText.time;
    const isStreaming = chatRenderMode === 'live' && typeof time?.end !== 'number';
    const throttledText = useStreamingTextThrottle({
        text: textContent,
        isStreaming,
        identityKey: `${messageId}:${part.id ?? 'reasoning'}`,
    });

    // Show reasoning even if time.end isn't set yet (during streaming)
    // Only hide if there's no text content
    if (!throttledText || throttledText.trim().length === 0) {
        return null;
    }

    return (
        <ReasoningTimelineBlock
            text={throttledText}
            variant="thinking"
            onContentChange={onContentChange}
            blockId={part.id || `${messageId}-reasoning`}
            time={time}
            isStreaming={isStreaming}
        />
    );
});

type MergedReasoningPartProps = {
    parts: Part[];
    onContentChange?: (reason?: ContentChangeReason) => void;
    messageId: string;
};

/**
 * Renders ALL reasoning parts for a message as a single collapsible block,
 * merging their text and spanning their combined time range.
 * This matches the VSCode Copilot pattern of showing one "Thought" block per turn.
 */
export const MergedReasoningPart = React.memo(({
    parts,
    onContentChange,
    messageId,
}: MergedReasoningPartProps) => {
    const chatRenderMode = useUIStore((state) => state.chatRenderMode);

    const mergedText = React.useMemo(() => {
        return parts
            .map((part) => {
                const p = part as PartWithText;
                return cleanReasoningText(p.text || p.content || '');
            })
            .filter((t) => t.length > 0)
            .join('\n\n');
    }, [parts]);

    const mergedTime = React.useMemo(() => {
        let earliestStart: number | undefined;
        let latestEnd: number | undefined;

        for (const part of parts) {
            const time = (part as PartWithText).time;
            if (typeof time?.start === 'number' && Number.isFinite(time.start)) {
                if (earliestStart === undefined || time.start < earliestStart) {
                    earliestStart = time.start;
                }
            }
            if (typeof time?.end === 'number' && Number.isFinite(time.end)) {
                if (latestEnd === undefined || time.end > latestEnd) {
                    latestEnd = time.end;
                }
            }
        }

        return earliestStart !== undefined ? { start: earliestStart, end: latestEnd } : undefined;
    }, [parts]);

    const isStreaming = chatRenderMode === 'live' && parts.some(
        (part) => typeof (part as PartWithText).time?.end !== 'number',
    );

    const throttledMergedText = useStreamingTextThrottle({
        text: mergedText,
        isStreaming,
        identityKey: `${messageId}:reasoning-merged`,
    });

    const blockId = parts[0]?.id ?? `${messageId}-reasoning-merged`;

    if (!throttledMergedText.trim()) {
        return null;
    }

    return (
        <ReasoningTimelineBlock
            text={throttledMergedText}
            variant="thinking"
            onContentChange={onContentChange}
            blockId={blockId}
            time={mergedTime}
            isStreaming={isStreaming}
        />
    );
});

// eslint-disable-next-line react-refresh/only-export-components
export const formatReasoningText = (text: string): string => cleanReasoningText(text);

export default ReasoningPart;
