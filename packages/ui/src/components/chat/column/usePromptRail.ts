import React from 'react';
import type { Message, Part } from '@/lib/opencode/model';
import { buildPromptPreviewsByTurnId } from '../lib/promptPreviews';
import { buildQuestionEntriesByTurnId, isPromptSelectorTurn, type QuestionAnswerEntry } from '../lib/questionEntries';

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
    // Keyed by the turn's id, the same keys the previews use, so a question
    // shows under the prompt row that asked it. Kept across streamed part
    // updates, like the previews above, so the rail's entries memo stays
    // stable while a reply streams.
    const questionsByTurnIdRef = React.useRef<Map<string, QuestionAnswerEntry[]>>(new Map());
    const questionsByTurnId = React.useMemo(() => {
        const next = buildQuestionEntriesByTurnId(renderedMessages);
        const previous = questionsByTurnIdRef.current;
        if (previous.size === next.size) {
            let unchanged = true;
            for (const [turnId, entries] of next) {
                if (previous.get(turnId) !== entries) {
                    unchanged = false;
                    break;
                }
            }
            if (unchanged) {
                return previous;
            }
        }
        questionsByTurnIdRef.current = next;
        return next;
    }, [renderedMessages]);
    // Only real (non-synthetic) prompts become rail entries; a turn whose
    // prompt has no readable text still appears when it asked a question.
    const promptTurnIds = React.useMemo(
        () => turnIds.filter((id) => isPromptSelectorTurn(id, promptPreviewsByTurnId, questionsByTurnId)),
        [promptPreviewsByTurnId, questionsByTurnId, turnIds],
    );
    const railActiveTurnId = React.useMemo(() => {
        if (!activeTurnId || isPromptSelectorTurn(activeTurnId, promptPreviewsByTurnId, questionsByTurnId)) {
            return activeTurnId;
        }
        const activeIndex = turnIds.indexOf(activeTurnId);
        for (let index = activeIndex - 1; index >= 0; index -= 1) {
            const turnId = turnIds[index];
            if (isPromptSelectorTurn(turnId, promptPreviewsByTurnId, questionsByTurnId)) {
                return turnId;
            }
        }
        return null;
    }, [activeTurnId, promptPreviewsByTurnId, questionsByTurnId, turnIds]);
    return { promptPreviewsByTurnId, promptTurnIds, railActiveTurnId, questionsByTurnId };
};
