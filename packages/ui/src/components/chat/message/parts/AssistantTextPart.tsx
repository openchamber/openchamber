import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';
import { MarkdownRenderer } from '../../MarkdownRenderer';
import type { StreamPhase } from '../types';
import type { ContentChangeReason } from '@/hooks/useChatScrollManager';
import { ReasoningTimelineBlock, formatReasoningText } from './ReasoningPart';
import { useStreamingTextThrottle } from '../../hooks/useStreamingTextThrottle';
import { resolveAssistantDisplayText, shouldRenderAssistantText } from './assistantTextVisibility';

type PartWithText = Part & { text?: string; content?: string; value?: string; time?: { start?: number; end?: number } };

interface AssistantTextPartProps {
    part: Part;
    messageId: string;
    streamPhase: StreamPhase;
    onContentChange?: (reason?: ContentChangeReason, messageId?: string) => void;
    renderAsReasoning?: boolean;
}

const AssistantTextPart: React.FC<AssistantTextPartProps> = ({
    part,
    messageId,
    streamPhase,
    onContentChange,
    renderAsReasoning = false,
}) => {
    const partWithText = part as PartWithText;
    const rawText = partWithText.text;
    const baseTextContent = typeof rawText === 'string' ? rawText : partWithText.content || partWithText.value || '';
    const textContent = React.useMemo(() => {
        if (renderAsReasoning) {
            return formatReasoningText(baseTextContent);
        }
        return baseTextContent;
    }, [baseTextContent, renderAsReasoning]);
    const isStreamingPhase = streamPhase === 'streaming';
    const isCooldownPhase = streamPhase === 'cooldown';
    const isStreaming = isStreamingPhase || isCooldownPhase;

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

    const time = partWithText.time;
    const isFinalized = Boolean(time && typeof time.end !== 'undefined');

    if (!shouldRenderAssistantText({
        displayTextContent,
        isFinalized,
    })) {
        return null;
    }

    if (renderAsReasoning) {
        return (
            <ReasoningTimelineBlock
                key={part.id || `${messageId}-text`}
                text={displayTextContent}
                variant="justification"
                onContentChange={onContentChange}
                blockId={part.id || `${messageId}-reasoning-text`}
                time={time}
            />
        );
    }

    return (
        <div className="group/assistant-text relative break-words" key={part.id || `${messageId}-text`}>
            <MarkdownRenderer
                content={displayTextContent}
                part={part}
                messageId={messageId}
                isAnimated={false}
                isStreaming={isStreaming}
            />
        </div>
    );
};

export default AssistantTextPart;
