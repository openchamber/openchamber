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
import { useGuestLinkRules } from '@/lib/guests/links';

type PartWithText = Part & { text?: string; content?: string; value?: string; time?: { start?: number; end?: number } };

const REPLY_REVEAL_INTERVAL_MS = 400;

interface AssistantTextPartProps {
    part: Part;
    sessionId?: string;
    messageId: string;
    streamPhase: StreamPhase;
    onShowPopup?: (content: ToolPopupContent) => void;
    range?: { start: number; end?: number };
}

const AssistantTextPart: React.FC<AssistantTextPartProps> = ({
    part,
    messageId,
    streamPhase,
    onShowPopup,
    range,
}) => {
    const guestLinks = useGuestLinkRules();
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

    const displayTextContent = resolveAssistantDisplayText({
        textContent,
        throttledTextContent,
        isStreaming,
    });

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
                range?.start ? null : 'mt-1',
                range?.end !== undefined ? null : 'mb-1',
            )}
            data-answer-continues={range?.start ? '' : undefined}
            data-answer-part={range ? `${messageId}:${part.id}` : undefined}
            key={part.id || `${messageId}-text`}
            data-reasoning-message-id={part.type === 'reasoning' ? messageId : undefined}
            data-reasoning-block-id={part.type === 'reasoning' ? part.id || `${messageId}-reasoning` : undefined}
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
                guestLinks={part.type === 'text' ? guestLinks : null}
            />
        </div>
    );
};

export default React.memo(AssistantTextPart);
