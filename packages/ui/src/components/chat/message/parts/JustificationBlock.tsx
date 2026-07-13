import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';
import type { ContentChangeReason } from '@/hooks/useChatAutoFollow';
import { useUIStore } from '@/stores/useUIStore';
import { ReasoningTimelineBlock } from './ReasoningPart';
import { useChatSearchContext } from '../../hooks/useChatSearchContext';

type PartWithText = Part & { text?: string; content?: string; value?: string; time?: { start?: number; end?: number } };

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
    actions?: React.ReactNode;
    partIndex: number;
}

const JustificationBlock: React.FC<JustificationBlockProps> = ({
    part,
    messageId,
    onContentChange,
    actions,
    partIndex,
}) => {
    const chatRenderMode = useUIStore((state) => state.chatRenderMode);
    const partWithText = part as PartWithText;
    const rawText = [partWithText.text, partWithText.content, partWithText.value].reduce<string>(
        (best, candidate) => typeof candidate === 'string' && candidate.length > best.length ? candidate : best,
        '',
    );
    const textContent = React.useMemo(() => cleanJustificationText(rawText), [rawText]);
    const time = partWithText.time;
    const searchContext = useChatSearchContext(messageId, part, partIndex);

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
            messageId={messageId}
            searchContext={searchContext}
            time={time}
            showDuration={chatRenderMode !== 'sorted'}
            actions={actions}
        />
    );
};

export default React.memo(JustificationBlock);
