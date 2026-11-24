import React from 'react';

import { useI18n } from '@/lib/i18n';

import { cn } from '@/lib/utils';
import { FormMarkdown } from '../../FormMarkdown';
import { USER_BUBBLE_TEXT_LINK_CLASS } from '../body/userBubbleLinkStyle';
import { QuestionAnswerRow, QuestionOptionRow } from './QuestionChoices';
import {
    selectedOptionLabels,
    withoutRecommendationPicks,
    type QuestionAnswerEntry,
} from '../../lib/questionEntries';

const ANSWER_CLAMP_CLASS = 'line-clamp-2';
const LONG_ANSWER_HINT_LENGTH = 160;

/**
 * A long answer follows the same two-line clamp and inline Show more link as a
 * long user message. The measurement refines the length fallback so a short
 * answer that happens to wrap still gets the link.
 */
const QuestionAnswerText: React.FC<{ answer: string }> = ({ answer }) => {
    const { t } = useI18n();
    const [expanded, setExpanded] = React.useState(false);
    const [overflowing, setOverflowing] = React.useState(answer.trim().length > LONG_ANSWER_HINT_LENGTH);
    const textRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        if (expanded) return;
        const element = textRef.current;
        if (!element) return;
        const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
        measure();
        // A font or layout settling after mount can change the wrapped height
        // of a short answer measured too early.
        const frame = window.requestAnimationFrame(measure);
        // The clamp pins the box's height, so a width change is what makes an
        // answer that fitted two lines wrap past them later (a narrowed window,
        // an opened sidebar, a rotated phone). Without this the answer stayed
        // clamped with no Show more link.
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => {
            window.cancelAnimationFrame(frame);
            observer.disconnect();
        };
    }, [answer, expanded]);

    const showToggle = expanded || overflowing;

    return (
        <div className="min-w-0">
            <div
                ref={textRef}
                dir="auto"
                className={cn(
                    'typography-meta whitespace-pre-wrap break-words text-foreground [unicode-bidi:plaintext]',
                    !expanded && ANSWER_CLAMP_CLASS,
                )}
            >
                {answer}
            </div>
            {showToggle ? (
                <div className="mt-0.5 flex justify-end">
                    <button
                        type="button"
                        className={USER_BUBBLE_TEXT_LINK_CLASS}
                        style={{ minHeight: 0, minWidth: 0 }}
                        aria-expanded={expanded}
                        onClick={(event) => {
                            event.stopPropagation();
                            setExpanded((current) => !current);
                        }}
                    >
                        {t(expanded ? 'chat.message.userText.showLess' : 'chat.message.userText.showMore')}
                    </button>
                </div>
            ) : null}
        </div>
    );
};

/** Whether the reply is exactly the option labels the row marks. */
const answerNamesSelectedOptions = (
    entry: QuestionAnswerEntry,
    selected: ReadonlySet<string>,
): boolean => {
    if (!entry.answer || selected.size === 0) return false;
    // The tool marks the option it recommends inside the reply, and a
    // multi-select reply can carry the marker on any of its picks, so both
    // sides are read with the markers gone.
    const answer = withoutRecommendationPicks(entry.answer.trim());
    const joined = entry.options
        .filter((option) => selected.has(option.label))
        .map((option) => option.label)
        .join(', ');
    return answer === joined;
};

/**
 * The block a collapsed question row draws under its header: one line per
 * question with the answer. Only a click: the header row above is the row's
 * one keyboard control, and a second tab stop would open the same row twice.
 */
export const QuestionCollapsedSummary: React.FC<{
    entries: readonly QuestionAnswerEntry[];
    onActivate?: () => void;
}> = ({ entries, onActivate }) => {
    const { t } = useI18n();
    if (entries.length === 0) return null;

    return (
        <div
            className={cn(
                'ms-5 space-y-1 border-s border-edge/60 py-1 ps-2.5',
                onActivate && 'cursor-pointer',
            )}
            onClick={onActivate}
        >
            {entries.map((entry) => {
                const answer = entry.answer
                    ? withoutRecommendationPicks(entry.answer.trim())
                    : (entry.pending
                        ? t('chat.toolPart.awaitingResponse')
                        : t('chat.toolPart.question.noAnswer'));
                return (
                    <div key={entry.partId} className="flex min-w-0 items-baseline gap-1.5 typography-meta">
                        <span dir="auto" className="min-w-0 truncate text-muted-foreground oc-ui-start-align" title={entry.question}>
                            {entry.question}
                        </span>
                        <span aria-hidden="true" className="flex-shrink-0 text-muted-foreground">—</span>
                        <span
                            dir="auto"
                            className={cn(
                                'min-w-0 max-w-[50%] flex-shrink-0 truncate oc-ui-start-align',
                                entry.answer ? 'text-foreground' : 'text-muted-foreground',
                            )}
                            title={answer}
                        >
                            {answer}
                        </span>
                    </div>
                );
            })}
        </div>
    );
};

/** The expanded question row: every option, the picks, and the answer. */
export const QuestionExpandedContent: React.FC<{ entries: readonly QuestionAnswerEntry[] }> = ({ entries }) => {
    const { t } = useI18n();
    if (entries.length === 0) {
        return <div className="typography-meta text-muted-foreground">{t('chat.toolPart.awaitingResponse')}</div>;
    }

    return (
        <div className="w-full min-w-0 space-y-3">
            {entries.map((entry) => {
                const selected = selectedOptionLabels(entry.options, entry.answer, entry.multiple);
                const answerIsSelection = answerNamesSelectedOptions(entry, selected);
                const emptyAnswer = entry.answer ? null : (entry.pending
                    ? t('chat.toolPart.awaitingResponse')
                    : t('chat.toolPart.question.noAnswer'));
                return (
                    <div
                        key={entry.partId}
                        className="min-w-0 border-t border-edge/60 pt-3 first:border-t-0 first:pt-0"
                    >
                        <FormMarkdown content={entry.question} size="meta" className="text-foreground" />
                        {entry.options.length > 0 ? (
                            <div className="mt-1.5">
                                {entry.options.map((option) => (
                                    <QuestionOptionRow
                                        key={option.label}
                                        option={option}
                                        chosen={selected.has(option.label)}
                                        multiple={entry.multiple}
                                    />
                                ))}
                            </div>
                        ) : null}
                        {answerIsSelection ? null : entry.answer ? (
                            // A typed answer reads as one more choice, marked chosen.
                            <QuestionAnswerRow multiple={entry.multiple}>
                                <QuestionAnswerText answer={withoutRecommendationPicks(entry.answer)} />
                            </QuestionAnswerRow>
                        ) : (
                            <div className="mt-1 typography-meta text-muted-foreground oc-ui-start-align">{emptyAnswer}</div>
                        )}
                    </div>
                );
            })}
        </div>
    );
};
