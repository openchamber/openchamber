import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';
import { MarkdownRenderer } from '../../MarkdownRenderer';
import type { StreamPhase } from '../types';
import type { ContentChangeReason } from '@/hooks/useChatScrollManager';
import { ReasoningTimelineBlock, formatReasoningText } from './ReasoningPart';

type PartWithText = Part & { text?: string; content?: string; value?: string; time?: { start?: number; end?: number } };

interface AssistantTextPartProps {
    part: Part;
    messageId: string;
    streamPhase: StreamPhase;
    allowAnimation: boolean;
    onContentChange?: (reason?: ContentChangeReason, messageId?: string) => void;
    renderAsReasoning?: boolean;
}

const AssistantTextPart: React.FC<AssistantTextPartProps> = ({
    part,
    messageId,
    streamPhase,
    allowAnimation,
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
    const wasStreamingRef = React.useRef(isStreamingPhase);

    if (isStreamingPhase || isCooldownPhase) {
        wasStreamingRef.current = true;
        return null;
    }

    const time = partWithText.time;
    const isFinalized = time && typeof time.end !== 'undefined';

    if (!isFinalized && (!textContent || textContent.trim().length === 0)) {
        return null;
    }

    if (!textContent || textContent.trim().length === 0) {
        return null;
    }

    if (renderAsReasoning) {
        return (
            <ReasoningTimelineBlock
                key={part.id || `${messageId}-text`}
                text={textContent}
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
                content={textContent}
                part={part}
                messageId={messageId}
                isAnimated={allowAnimation}
                isStreaming={false}
            />
        </div>
    );
};

export default AssistantTextPart;
