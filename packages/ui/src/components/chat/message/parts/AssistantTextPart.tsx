import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';
import { MarkdownRenderer } from '../../MarkdownRenderer';
import type { StreamPhase } from '../types';
import type { ContentChangeReason } from '@/hooks/useChatScrollManager';
import { useStreamingTextThrottle } from '../../hooks/useStreamingTextThrottle';
import { resolveAssistantDisplayText, shouldRenderAssistantText } from './assistantTextVisibility';

type PartWithText = Part & { text?: string; content?: string; value?: string; time?: { start?: number; end?: number } };

interface AssistantTextPartProps {
    part: Part;
    messageId: string;
    streamPhase: StreamPhase;
    chatRenderMode?: 'sorted' | 'live';
    onContentChange?: (reason?: ContentChangeReason, messageId?: string) => void;
}

const AssistantTextPart: React.FC<AssistantTextPartProps> = ({
    part,
    messageId,
    streamPhase,
    chatRenderMode = 'live',
}) => {
    const partWithText = part as PartWithText;
    const rawText = typeof partWithText.text === 'string' ? partWithText.text : '';
    const contentText = typeof partWithText.content === 'string' ? partWithText.content : '';
    const valueText = typeof partWithText.value === 'string' ? partWithText.value : '';
    const textContent = [rawText, contentText, valueText].reduce((best, candidate) => {
        return candidate.length > best.length ? candidate : best;
    }, '');
    const isStreamingPhase = streamPhase === 'streaming';
    const isCooldownPhase = streamPhase === 'cooldown';
    const isStreaming = chatRenderMode === 'live' && (isStreamingPhase || isCooldownPhase);

    const throttledTextContent = useStreamingTextThrottle({
        text: textContent,
        isStreaming,
        identityKey: `${messageId}:${part.id ?? 'text'}`,
    });

    const displayTextContent = resolveAssistantDisplayText({
        textContent,
        throttledTextContent,
        isStreaming,
    });

    const lastDisplayLengthRef = React.useRef(0);
    React.useEffect(() => {
        if (!isStreaming || typeof window === 'undefined') {
            lastDisplayLengthRef.current = displayTextContent.length;
            return;
        }
        const debugEnabled = window.localStorage.getItem('openchamber_stream_debug') === '1';
        if (!debugEnabled) {
            lastDisplayLengthRef.current = displayTextContent.length;
            return;
        }
        if (displayTextContent.length < lastDisplayLengthRef.current) {
            console.info('[STREAM-TRACE] render_shrink', {
                messageId,
                partId: part.id,
                rawTextLen: rawText.length,
                contentLen: contentText.length,
                valueLen: valueText.length,
                chosenLen: textContent.length,
                throttledLen: throttledTextContent.length,
                displayLen: displayTextContent.length,
                prevDisplayLen: lastDisplayLengthRef.current,
            });
        }
        lastDisplayLengthRef.current = displayTextContent.length;
    }, [contentText.length, displayTextContent.length, isStreaming, messageId, part.id, rawText.length, textContent.length, throttledTextContent.length, valueText.length]);

    const time = partWithText.time;
    const isFinalized = Boolean(time && typeof time.end !== 'undefined');

    const isRenderableTextPart = part.type === 'text' || part.type === 'reasoning';
    if (!isRenderableTextPart) {
        return null;
    }

    if (!shouldRenderAssistantText({
        displayTextContent,
        isFinalized,
    })) {
        return null;
    }

    return (
        <div className="group/assistant-text relative break-words" key={part.id || `${messageId}-text`}>
            <MarkdownRenderer
                content={displayTextContent}
                part={part}
                messageId={messageId}
                isAnimated={false}
                isStreaming={isStreaming}
                disableStreamAnimation={chatRenderMode === 'sorted'}
                variant={part.type === 'reasoning' ? 'reasoning' : 'assistant'}
            />
        </div>
    );
};

export default AssistantTextPart;
