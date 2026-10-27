import React from 'react';
import { cn } from '@/lib/utils';
import type { Part } from '@/lib/opencode/model';
import { MarkdownRenderer } from '../../MarkdownRenderer';
import type { StreamPhase, ToolPopupContent } from '../types';
import { useStreamingTextThrottle } from '../../hooks/useStreamingTextThrottle';
import { resolveAssistantDisplayText, resolveAssistantTextStreaming } from './assistantTextVisibility';
import { isInvisibleText } from '@/lib/invisibleText';
import { streamPerfCount, streamPerfObserve } from '@/stores/utils/streamDebug';
import { GeneratedJsonResultCard } from './GeneratedJsonResultCard';
import { parseGeneratedJsonResult } from './generatedJsonResult';

type PartWithText = Part & { text?: string; content?: string; value?: string; time?: { start?: number; end?: number } };

// A streaming reply is read a block at a time (see streamTextCommit.ts); taking
// new text at most this often lets the blocks finished in between land, and
// move the chat, together.
const REPLY_REVEAL_INTERVAL_MS = 400;

interface AssistantTextPartProps {
    part: Part;
    sessionId?: string;
    messageId: string;
    streamPhase: StreamPhase;
    onShowPopup?: (content: ToolPopupContent) => void;
    /**
     * The stretch of a finished text this row draws, when a long answer spans
     * several transcript rows (`timelineRows.ts`).
     */
    range?: { start: number; end?: number };
    allowOpenUI?: boolean;
}

const AssistantTextPart: React.FC<AssistantTextPartProps> = ({
    part,
    messageId,
    streamPhase,
    onShowPopup,
    range,
    allowOpenUI = false,
}) => {
    // Use part directly from props — parent provides the latest version from the store.
    // No store subscription here to avoid re-render cascade from unrelated delta events.
    const partWithText = part as PartWithText;
    const rawText = typeof partWithText.text === 'string' ? partWithText.text : '';
    const contentText = typeof partWithText.content === 'string' ? partWithText.content : '';
    const valueText = typeof partWithText.value === 'string' ? partWithText.value : '';
    const fullText = [rawText, contentText, valueText].reduce((best, candidate) => {
        return candidate.length > best.length ? candidate : best;
    }, '');
    const textContent = range ? fullText.slice(range.start, range.end) : fullText;
    const time = partWithText.time;
    const isFinalized = Boolean(time && typeof time.end !== 'undefined');
    const isStreaming = resolveAssistantTextStreaming({
        streamPhase,
        isFinalized,
    });

    streamPerfCount('ui.assistant_text_part.render');
    if (isStreaming) {
        streamPerfCount('ui.assistant_text_part.render.streaming');
    }

    const throttledTextContent = useStreamingTextThrottle({
        text: textContent,
        isStreaming,
        throttleMs: REPLY_REVEAL_INTERVAL_MS,
        identityKey: `${messageId}:${part.id ?? 'text'}`,
    });

    const displayedSource = isStreaming ? throttledTextContent : textContent;
    const display = React.useMemo(() => resolveAssistantDisplayText({
        textContent: displayedSource,
        throttledTextContent: displayedSource,
        isStreaming,
        allowOpenUI,
    }), [displayedSource, isStreaming, allowOpenUI]);
    const displayTextContent = display.content;

    streamPerfObserve('ui.assistant_text_part.display_len', displayTextContent.length);

    const isRenderableTextPart = part.type === 'text' || part.type === 'reasoning';
    if (!isRenderableTextPart) {
        return null;
    }

    if (isInvisibleText(displayTextContent)) {
        return null;
    }

    const generatedResult = !isStreaming && isFinalized && !range ? parseGeneratedJsonResult(displayTextContent) : null;
    if (generatedResult) {
        return (
            <div
                className="group/assistant-text relative my-1 break-words"
                key={part.id || `${messageId}-text`}
            >
                <GeneratedJsonResultCard result={generatedResult} />
            </div>
        );
    }

    return (
        <div
            className={cn(
                'group/assistant-text relative break-words',
                // Rows of one answer stack as the whole text did: only its
                // outer edges keep their spacing.
                range?.start ? null : 'mt-1',
                range?.end !== undefined ? null : 'mb-1',
            )}
            data-answer-continues={range?.start ? '' : undefined}
            // Its rows read as one text when a selection crosses them.
            data-answer-part={range ? `${messageId}:${part.id}` : undefined}
            key={part.id || `${messageId}-text`}
            // The chat scroll stops following once the start of the reply
            // being written would leave the screen (useChatTimelineScroll).
            data-streaming-reply={isStreaming && part.type === 'text' ? '' : undefined}
        >
            <MarkdownRenderer
                content={displayTextContent}
                part={part}
                messageId={messageId}
                isAnimated={false}
                isStreaming={isStreaming}
                variant={part.type === 'reasoning' ? 'reasoning' : 'assistant'}
                enableFileReferences={isFinalized}
                onShowPopup={onShowPopup}
                allowOpenUI={allowOpenUI}
                canonicalContent={textContent}
                openuiFullSource={fullText}
                openuiRange={range}
                openuiSource={display.openuiSource}
            />
        </div>
    );
};

export default React.memo(AssistantTextPart);
