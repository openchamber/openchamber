import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { RecordedQuestionAnswer } from '@/lib/opencode/questionAnswers';
import { stripRecommendedMarker } from '../../formSerializers';
import { questionSentence } from './toolRow/questionOutput';

const BUBBLE_STYLE: React.CSSProperties = {
    backgroundColor: 'var(--chat-user-message-bg)',
    borderRadius: 'var(--radius-xl)',
    borderEndEndRadius: 'var(--radius-sm)',
};

export function QuestionAnswerCard({ answers }: { answers: readonly RecordedQuestionAnswer[] }) {
    const { t } = useI18n();
    return (
        <div className="my-2 flex flex-col items-end" data-question-answer-card="">
            <div className="max-w-[85%] space-y-3 border border-primary/5 px-5 py-3" style={BUBBLE_STYLE}>
                {answers.map(({ question, picks }, index) => (
                    <div key={index} className="min-w-0 border-s-3 border-primary/45 ps-3">
                        <div className="flex min-w-0 items-start gap-1.5 text-xs text-muted-foreground" title={question}>
                            <Icon name="question" className="mt-px h-3.5 w-3.5 shrink-0" />
                            <span dir="auto" className="line-clamp-2 min-w-0">{questionSentence(question)}</span>
                        </div>
                        {picks.length > 0 ? (
                            <div dir="auto" className="mt-1.5 whitespace-pre-wrap break-words font-sans text-sm text-[var(--surface-foreground)]">
                                {picks.map(stripRecommendedMarker).join(', ')}
                            </div>
                        ) : (
                            <div className="mt-1.5 text-sm italic text-muted-foreground">{t('chat.htmlRender.unanswered')}</div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}
