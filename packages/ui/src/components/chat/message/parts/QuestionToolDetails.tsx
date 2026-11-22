import React from 'react';
import { useI18n } from '@/lib/i18n';
import type { ToolPart, ToolState } from '@/lib/opencode/model';
import { type QuestionAnswer, questionAnswers, questionCallKey, questionPrompts } from '@/lib/opencode/question';
import type { LateAnswerMode } from '@/lib/questionTimeout';
import { useInputStore } from '@/sync/input-store';
import { useUIStore } from '@/stores/useUIStore';
import { useChatColumnActions, useChatColumnTakesPrompts, useChatSessionSelection } from '../../chatColumnSession';
import { formatQuestionAnswers, formatQuestionsAsMarkdown, rememberQuestionAnswers, startingQuestionAnswers } from '../../questionAnswers';
import { copyTextToClipboard } from '@/lib/clipboard';
import { toast } from '@/components/ui';
import { useQuestionCloseReason } from '@/sync/question-timeouts';
import { type LateAnswer, QuestionToolDetailsView, type QuestionToolDetailsViewProps } from './QuestionToolDetailsView';

const LATE_ANSWER_GUIDANCE_KEYS = {
    consider: 'chat.questionAnswers.message.steer.consider',
    exact: 'chat.questionAnswers.message.steer.exact',
    fyi: 'chat.questionAnswers.message.steer.fyi',
} as const satisfies Record<LateAnswerMode, string>;

/**
 * The expanded row of an agent's `question` call: every question with all of
 * its options and their descriptions, whatever way the call ended, and the
 * answers when the call returned some. Once the call has ended, the questions
 * can be answered again from here; the answers go to the agent as a new
 * message, since the call itself is over, with a line saying how they weigh
 * against what the agent did meanwhile and the user's note. A question that
 * closed on its timeout is shown greyed out. Copy takes every question with
 * the answers shown, or the picks the user made before it closed.
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
    const closeReason = useQuestionCloseReason(callKey);

    const startingAnswers = React.useCallback(() => startingQuestionAnswers(callKey, answers), [answers, callKey]);
    const handleKeep = React.useCallback((kept: QuestionAnswer[]) => rememberQuestionAnswers(callKey, kept), [callKey]);
    const handleSend = React.useCallback((sent: QuestionAnswer[], late: LateAnswer) => {
        rememberQuestionAnswers(callKey, sent);
        const text = formatQuestionAnswers(prompts, sent, {
            intro: t('chat.questionAnswers.message.intro'),
            unanswered: t('chat.questionAnswers.message.unanswered'),
            guidance: t(LATE_ANSWER_GUIDANCE_KEYS[late.mode]),
            note: late.note ? t('chat.questionAnswers.message.note', { note: late.note }) : undefined,
        });
        useInputStore.getState().requestSessionSubmit({ target: pinned ? part.sessionID : null, sessionId: part.sessionID, text });
    }, [callKey, part.sessionID, pinned, prompts, t]);

    const handleCopy = React.useCallback(async () => {
        const text = formatQuestionsAsMarkdown(prompts, startingQuestionAnswers(callKey, answers), {
            answer: t('chat.questionAnswers.ownAnswer'),
            unanswered: t('chat.questionAnswers.message.unanswered'),
        });
        const result = await copyTextToClipboard(text);
        if (result.ok) toast.success(t('chat.questionAnswers.copied'));
        else toast.error(t('chat.questionCard.copyFailed'));
    }, [answers, callKey, prompts, t]);

    return (
        <QuestionToolDetailsView
            prompts={prompts}
            answers={answers}
            errorText={state.status === 'error' ? state.error : null}
            canAnswer={canAnswer}
            closeReason={closeReason}
            onCopy={() => void handleCopy()}
            startingAnswers={startingAnswers}
            onKeep={handleKeep}
            onSend={handleSend}
            isMobile={isMobile}
            renderScrollBox={renderScrollBox}
        />
    );
}
