import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';
import type { ContentChangeReason } from '@/hooks/useChatScrollManager';
import { ReasoningTimelineBlock } from './ReasoningPart';

type PartWithText = Part & { text?: string; content?: string; time?: { start?: number; end?: number } };

const cleanJustificationText = (text: string): string => {
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

interface JustificationBlockProps {
    part: Part;
    messageId: string;
    onContentChange?: (reason?: ContentChangeReason) => void;
}

const JustificationBlock: React.FC<JustificationBlockProps> = ({
    part,
    messageId,
    onContentChange,
}) => {
    const partWithText = part as PartWithText;
    const rawText = partWithText.text || partWithText.content || '';
    const textContent = React.useMemo(() => cleanJustificationText(rawText), [rawText]);
    const time = partWithText.time;

    // Don't render if there's no text content
    if (!textContent || textContent.trim().length === 0) {
        return null;
    }

    return (
        <ReasoningTimelineBlock
            text={textContent}
            variant="justification"
            onContentChange={onContentChange}
            blockId={part.id || `${messageId}-justification`}
            time={time}
        />
    );
};

export default React.memo(JustificationBlock);
