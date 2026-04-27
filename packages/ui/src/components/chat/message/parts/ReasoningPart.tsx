import React from 'react';
import type { ComponentType } from 'react';
import type { Part } from '@opencode-ai/sdk/v2';
import { RiArrowDownSLine, RiArrowRightSLine, RiBrainAi3Line, RiChatAi3Line } from '@remixicon/react';
import { cn } from '@/lib/utils';
import type { ContentChangeReason } from '@/hooks/useChatScrollManager';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useUIStore } from '@/stores/useUIStore';
import { useDurationTickerNow } from './useDurationTicker';
import { MarkdownRenderer } from '../../MarkdownRenderer';
import { useStreamingTextThrottle } from '../../hooks/useStreamingTextThrottle';

type PartWithText = Part & { text?: string; content?: string; time?: { start?: number; end?: number } };

export type ReasoningVariant = 'thinking' | 'justification';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IconComponent = ComponentType<any>;

const variantConfig: Record<
    ReasoningVariant,
    { label: string; Icon: IconComponent }
> = {
    thinking: { label: 'Thinking', Icon: RiBrainAi3Line },
    justification: { label: 'Justification', Icon: RiChatAi3Line },
};

const cleanReasoningText = (text: string): string => {
    if (typeof text !== 'string' || text.trim().length === 0) {
        return '';
    }

    // Strip leading blockquote markers ("> ") but preserve blank lines
    // so markdown paragraph breaks and structure are kept intact.
    return text
        .split('\n')
        .map((line: string) => line.replace(/^>\s?/, '').trimEnd())
        .join('\n')
        .trim();
};

const getReasoningSummary = (text: string): string => {
    if (!text) {
        return '';
    }

    const trimmed = text.trim();
    const newlineIndex = trimmed.indexOf('\n');
    const periodIndex = trimmed.indexOf('.');

    const cutoffCandidates = [
        newlineIndex >= 0 ? newlineIndex : Infinity,
        periodIndex >= 0 ? periodIndex : Infinity,
    ];
    const cutoff = Math.min(...cutoffCandidates);

    if (!Number.isFinite(cutoff)) {
        return trimmed;
    }

    return trimmed.substring(0, cutoff).trim();
};

const formatDuration = (start: number, end?: number, now: number = Date.now()): string => {
    const duration = end ? end - start : now - start;
    const seconds = duration / 1000;
    const displaySeconds = seconds < 0.05 && end !== undefined ? 0.1 : seconds;
    return `${displaySeconds.toFixed(1)}s`;
};

const LiveDuration: React.FC<{ start: number; end?: number; active: boolean }> = ({ start, end, active }) => {
    const now = useDurationTickerNow(active, 250);

    return <>{formatDuration(start, end, now)}</>;
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
};

export const ReasoningTimelineBlock: React.FC<ReasoningTimelineBlockProps> = ({
    text,
    variant,
    onContentChange,
    blockId,
    time,
    showDuration = true,
    isStreaming = false,
    actions,
}) => {
    const [isExpanded, setIsExpanded] = React.useState(false);

    const summary = React.useMemo(() => getReasoningSummary(text), [text]);
    const { label, Icon } = variantConfig[variant];
    const timeStart = typeof time?.start === 'number' && Number.isFinite(time.start) ? time.start : undefined;
    const timeEnd = typeof time?.end === 'number' && Number.isFinite(time.end) ? time.end : undefined;

    React.useEffect(() => {
        if (text.trim().length === 0) {
            return;
        }
        onContentChange?.('structural');
    }, [onContentChange, text]);

    if (!text || text.trim().length === 0) {
        return null;
    }

    return (
        <div className="my-1" data-reasoning-block-id={blockId} data-message-text-export-root="true">
            <div
                className={cn(
                    'group/tool flex items-center gap-2 pr-2 pl-px py-1.5 rounded-xl cursor-pointer'
                )}
                onClick={() => setIsExpanded((prev) => !prev)}
            >
                <div className="flex items-center gap-2 flex-shrink-0">
                    <div className="relative h-3.5 w-3.5 flex-shrink-0">
                        <div
                            className={cn(
                                'absolute inset-0 transition-opacity',
                                isExpanded && 'opacity-0',
                                !isExpanded && 'group-hover/tool:opacity-0'
                            )}
                        >
                            <Icon className="h-3.5 w-3.5" />
                        </div>
                        <div
                            className={cn(
                                'absolute inset-0 transition-opacity flex items-center justify-center',
                                isExpanded && 'opacity-100',
                                !isExpanded && 'opacity-0 group-hover/tool:opacity-100'
                            )}
                        >
                            {isExpanded ? <RiArrowDownSLine className="h-3.5 w-3.5" /> : <RiArrowRightSLine className="h-3.5 w-3.5" />}
                        </div>
                    </div>
                    <span className="typography-meta font-medium">{label}</span>
                </div>

                {(summary || (showDuration && typeof timeStart === 'number')) ? (
                    <div className="flex items-center gap-1 flex-1 min-w-0 typography-meta text-muted-foreground/70">
                        {summary ? <span className="flex-1 min-w-0 truncate [&_p]:inline [&_*]:inline"><MarkdownRenderer content={summary} messageId={blockId} isAnimated={false} isStreaming={false} variant="reasoning" /></span> : null}
                        {showDuration && typeof timeStart === 'number' ? (
                            <span className="relative flex-shrink-0 tabular-nums text-right">
                                <span className="text-muted-foreground/80 transition-opacity duration-150">
                                    <LiveDuration
                                        start={timeStart}
                                        end={timeEnd}
                                        active={typeof timeEnd !== 'number'}
                                    />
                                </span>
                            </span>
                        ) : null}
                    </div>
                ) : null}
            </div>

            {isExpanded && (
                <div
                    className={cn(
                        'relative pr-2 pb-2 pt-2 pl-4'
                    )}
                >
                    <ScrollableOverlay
                        as="div"
                        outerClassName="max-h-80"
                        className="p-0"
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
            showDuration={chatRenderMode !== 'sorted'}
            isStreaming={isStreaming}
        />
    );
});

// eslint-disable-next-line react-refresh/only-export-components
export const formatReasoningText = (text: string): string => cleanReasoningText(text);

export default ReasoningPart;
