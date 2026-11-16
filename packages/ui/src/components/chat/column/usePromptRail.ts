import React from 'react';
import type { Message, Part } from '@/lib/opencode/model';
import { buildPromptPreviewsByTurnId } from '../lib/promptPreviews';

/** The prompt navigator's entries: real prompts only, with the active one resolved. */
export const usePromptRail = ({
    renderedMessages,
    turnIds,
    activeTurnId,
}: {
    renderedMessages: Array<{ info: Message; parts: Part[] }>;
    turnIds: string[];
    activeTurnId: string | null;
}) => {
    const promptPreviewsByTurnIdRef = React.useRef<Map<string, Part[]>>(new Map());
    const promptPreviewsByTurnId = React.useMemo(() => {
        const next = buildPromptPreviewsByTurnId(renderedMessages);
        const prev = promptPreviewsByTurnIdRef.current;
        if (prev.size === next.size) {
            let unchanged = true;
            for (const [id, parts] of next) {
                if (prev.get(id) !== parts) {
                    unchanged = false;
                    break;
                }
            }
            if (unchanged) {
                return prev;
            }
        }
        promptPreviewsByTurnIdRef.current = next;
        return next;
    }, [renderedMessages]);
    // Only real (non-synthetic) prompts become rail entries; selection still
    // targets the same turn anchors as the timeline.
    const promptTurnIds = React.useMemo(
        () => turnIds.filter((id) => promptPreviewsByTurnId.has(id)),
        [promptPreviewsByTurnId, turnIds],
    );
    // If the viewport sits in a filtered-out (synthetic) turn, treat the
    // nearest preceding real prompt as active so the rail doesn't jump.
    const railActiveTurnId = React.useMemo(() => {
        if (!activeTurnId || promptPreviewsByTurnId.has(activeTurnId)) {
            return activeTurnId;
        }
        const activeIndex = turnIds.indexOf(activeTurnId);
        for (let index = activeIndex - 1; index >= 0; index -= 1) {
            const turnId = turnIds[index];
            if (promptPreviewsByTurnId.has(turnId)) {
                return turnId;
            }
        }
        return null;
    }, [activeTurnId, promptPreviewsByTurnId, turnIds]);
    return { promptPreviewsByTurnId, promptTurnIds, railActiveTurnId };
};
