import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { QuestionOption } from '../../lib/questionEntries';

/**
 * The rows a question's answer is read through, in the transcript's card and in
 * the `ToolPart` copy alike. One owner because the two drifted: a multi-select
 * drew a radio in the card and a checkbox here, and the card's text lost the
 * interface alignment every `dir="auto"` span needs. Both surfaces draw the
 * same thing.
 *
 * The mark is the question's own colour, not the app's selection blue: a chosen
 * answer is part of the question, and the card's rail is already that colour.
 */
const OptionMark: React.FC<{ chosen: boolean; multiple: boolean }> = ({ chosen, multiple }) => (
    <span
        aria-hidden="true"
        className={cn(
            'mt-0.5 flex size-3.5 flex-shrink-0 items-center justify-center border',
            multiple ? 'rounded-[3px]' : 'rounded-full',
        )}
        style={{ borderColor: chosen ? 'var(--status-question)' : 'var(--status-question-border)' }}
    >
        {chosen ? (
            multiple
                ? <Icon name="check" className="size-2.5" style={{ color: 'var(--status-question)' }} />
                : <span className="size-1.5 rounded-full" style={{ backgroundColor: 'var(--status-question)' }} />
        ) : null}
    </span>
);

/** The line one choice takes: its mark, then what it says. */
const ChoiceLine: React.FC<{ chosen: boolean; multiple: boolean; children: React.ReactNode }> = ({
    chosen,
    multiple,
    children,
}) => (
    <div className="flex items-start gap-2.5 py-0.5">
        <OptionMark chosen={chosen} multiple={multiple} />
        <span className="min-w-0">{children}</span>
    </div>
);

/**
 * One option of a question: its label, the description under it, and a word a
 * screen reader hears when it is the chosen one (the mark is a shape, and a
 * list read aloud would otherwise be a list of undifferentiated options).
 */
export const QuestionOptionRow: React.FC<{
    option: QuestionOption;
    chosen: boolean;
    multiple: boolean;
}> = ({ option, chosen, multiple }) => {
    const { t } = useI18n();
    return (
        <ChoiceLine chosen={chosen} multiple={multiple}>
            <span
                dir="auto"
                className={cn(
                    'block break-words typography-markdown leading-snug oc-ui-start-align',
                    chosen ? 'font-medium text-foreground' : 'text-muted-foreground',
                )}
            >
                {option.label}
            </span>
            {option.description ? (
                <span dir="auto" className="block break-words typography-meta text-muted-foreground oc-ui-start-align">
                    {option.description}
                </span>
            ) : null}
            {chosen ? <span className="sr-only">{t('chat.questionCard.chosen')}</span> : null}
        </ChoiceLine>
    );
};

/** An answer that names no option, marked as the one given. */
export const QuestionAnswerRow: React.FC<{ multiple: boolean; children: React.ReactNode }> = ({
    multiple,
    children,
}) => (
    <ChoiceLine chosen multiple={multiple}>
        {children}
    </ChoiceLine>
);

/** An answer as one marked line of the card's own type scale. */
export const QuestionAnswerLine: React.FC<{ answer: string }> = ({ answer }) => (
    <span dir="auto" className="block whitespace-pre-wrap break-words typography-markdown font-medium leading-snug text-foreground oc-ui-start-align">
        {answer}
    </span>
);
