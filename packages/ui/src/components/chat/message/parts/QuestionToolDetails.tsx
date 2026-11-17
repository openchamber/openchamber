import React from 'react';
import { useI18n } from '@/lib/i18n';
import type { ToolPart, ToolState } from '@/lib/opencode/model';
import { type QuestionAnswer, questionAnswers, questionCallKey, questionPrompts } from '@/lib/opencode/question';
import { useInputStore } from '@/sync/input-store';
import { useUIStore } from '@/stores/useUIStore';
import { useChatColumnActions, useChatColumnTakesPrompts, useChatSessionSelection } from '../../chatColumnSession';
import { formatQuestionAnswers, rememberQuestionAnswers, startingQuestionAnswers } from '../../questionAnswers';
import { QuestionToolDetailsView, type QuestionToolDetailsViewProps } from './QuestionToolDetailsView';

/**
 * The expanded row of an agent's `question` call: every question with all of
 * its options and their descriptions, whatever way the call ended, and the
 * answers when the call returned some. Once the call has ended, the questions
 * can be answered again from here; the answers go to the agent as a new
 * message, since the call itself is over.
 */
export function QuestionToolDetails({ part, state, renderScrollBox }: {
    part: ToolPart;
    state: ToolState;
    renderScrollBox: QuestionToolDetailsViewProps['renderScrollBox'];
}) {
    const { t } = useI18n();
    const prompts = React.useMemo(() => questionPrompts(state.input), [state.input]);
    const answers = React.useMemo(() => questionAnswers(state), [state]);
    const callKey = questionCallKey({ messageID: part.messageID, callID: part.callID });

    // Only the chat showing this call's session can send in it, and only when
    // that chat takes prompts: its composer is the one that sends the answers.
    const { sessionId } = useChatSessionSelection();
    const { pinned } = useChatColumnActions();
    const takesPrompts = useChatColumnTakesPrompts();
    const isMobile = useUIStore((store) => store.isMobile);
    const ended = state.status === 'completed' || state.status === 'error';
    const canAnswer = ended && part.sessionID === sessionId && takesPrompts;

    const startingAnswers = React.useCallback(() => startingQuestionAnswers(callKey, answers), [answers, callKey]);
    const handleKeep = React.useCallback((kept: QuestionAnswer[]) => rememberQuestionAnswers(callKey, kept), [callKey]);
    const handleSend = React.useCallback((sent: QuestionAnswer[]) => {
        rememberQuestionAnswers(callKey, sent);
        const text = formatQuestionAnswers(prompts, sent, {
            intro: t('chat.questionAnswers.message.intro'),
            unanswered: t('chat.questionAnswers.message.unanswered'),
        });
        useInputStore.getState().requestSessionSubmit({ target: pinned ? part.sessionID : null, sessionId: part.sessionID, text });
    }, [callKey, part.sessionID, pinned, prompts, t]);

    return (
        <QuestionToolDetailsView
            prompts={prompts}
            answers={answers}
            errorText={state.status === 'error' ? state.error : null}
            canAnswer={canAnswer}
            startingAnswers={startingAnswers}
            onKeep={handleKeep}
            onSend={handleSend}
            isMobile={isMobile}
            renderScrollBox={renderScrollBox}
        />
    );
}
