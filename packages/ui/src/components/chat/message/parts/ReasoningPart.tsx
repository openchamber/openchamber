import React from 'react';
import type { ComponentType } from 'react';
import type { Part } from '@opencode-ai/sdk/v2';
import { RiArrowDownSLine, RiArrowRightSLine, RiBrainAi3Line, RiChatAi3Line } from '@remixicon/react';
import { cn } from '@/lib/utils';
import { formatTimestampForDisplay } from '../timeFormat';
import type { ContentChangeReason } from '@/hooks/useChatScrollManager';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';

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

    return text
        .split('\n')
        .map((line: string) => line.replace(/^>\s?/, '').trimEnd())
        .filter((line: string) => line.trim().length > 0)
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
    const [now, setNow] = React.useState(() => Date.now());

    React.useEffect(() => {
        if (!active) {
            return;
        }

        const timer = window.setInterval(() => {
            setNow(Date.now());
        }, 100);

        return () => window.clearInterval(timer);
    }, [active]);

    return <>{formatDuration(start, end, now)}</>;
};

type ReasoningTimelineBlockProps = {
    text: string;
    variant: ReasoningVariant;
    onContentChange?: (reason?: ContentChangeReason) => void;
    blockId: string;
    time?: { start?: number; end?: number };
};

export const ReasoningTimelineBlock: React.FC<ReasoningTimelineBlockProps> = ({
    text,
    variant,
    onContentChange,
    blockId,
    time,
}) => {
    const [isExpanded, setIsExpanded] = React.useState(false);

    const summary = React.useMemo(() => getReasoningSummary(text), [text]);
    const { label, Icon } = variantConfig[variant];
    const timeStart = typeof time?.start === 'number' && Number.isFinite(time.start) ? time.start : undefined;
    const timeEnd = typeof time?.end === 'number' && Number.isFinite(time.end) ? time.end : undefined;
    const endedTimestampText = React.useMemo(() => {
        if (typeof timeEnd !== 'number') {
            return null;
        }

        const formatted = formatTimestampForDisplay(timeEnd);
        return formatted.length > 0 ? formatted : null;
    }, [timeEnd]);

    React.useEffect(() => {
        if (text.trim().length === 0) {
            return;
        }
        onContentChange?.('structural');
    }, [onContentChange, isExpanded, text]);

    if (!text || text.trim().length === 0) {
        return null;
    }

    return (
        <div className="my-1" data-reasoning-block-id={blockId}>
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

                {(summary || typeof timeStart === 'number' || endedTimestampText) ? (
                    <div className="flex items-center gap-1 flex-1 min-w-0 typography-meta text-muted-foreground/70">
                        {summary ? <span className="truncate italic">{summary}</span> : null}
                        {typeof timeStart === 'number' ? (
                            <span className="text-muted-foreground/80 flex-shrink-0 tabular-nums">
                                <LiveDuration
                                    start={timeStart}
                                    end={timeEnd}
                                    active={typeof timeEnd !== 'number'}
                                />
                            </span>
                        ) : null}
                        {endedTimestampText ? (
                            <span
                                className={cn(
                                    'text-muted-foreground/70 flex-shrink-0 tabular-nums transition-opacity duration-150',
                                    'opacity-0 group-hover/tool:opacity-100'
                                )}
                            >
                                {endedTimestampText}
                            </span>
                        ) : null}
                    </div>
                ) : null}
            </div>

            {isExpanded && (
                <div
                    className={cn(
                        'relative pr-2 pb-2 pt-2 pl-[1.4375rem]',
                        'before:absolute before:left-[0.4375rem] before:w-px before:bg-border/80 before:content-[""]',
                        'before:top-[-0.25rem] before:bottom-0'
                    )}
                >
                    <ScrollableOverlay
                        as="blockquote"
                        outerClassName="max-h-80"
                        className="whitespace-pre-wrap break-words typography-meta italic text-muted-foreground/70 p-0"
                    >
                        {text}
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

const ReasoningPart: React.FC<ReasoningPartProps> = ({
    part,
    onContentChange,
    messageId,
}) => {
    const partWithText = part as PartWithText;
    const rawText = partWithText.text || partWithText.content || '';
    const textContent = React.useMemo(() => cleanReasoningText(rawText), [rawText]);
    const time = partWithText.time;

    // Show reasoning even if time.end isn't set yet (during streaming)
    // Only hide if there's no text content
    if (!textContent || textContent.trim().length === 0) {
        return null;
    }

    return (
        <ReasoningTimelineBlock
            text={textContent}
            variant="thinking"
            onContentChange={onContentChange}
            blockId={part.id || `${messageId}-reasoning`}
            time={time}
        />
    );
};

// eslint-disable-next-line react-refresh/only-export-components
export const formatReasoningText = (text: string): string => cleanReasoningText(text);

export default ReasoningPart;
