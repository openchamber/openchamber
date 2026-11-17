import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { isIMECompositionEvent } from '@/lib/ime';
import { useI18n } from '@/lib/i18n';
import { type QuestionAnswer, type QuestionPrompt, questionFormFields } from '@/lib/opencode/question';
import { FormFieldControl } from '../../FormFieldControl';
import { FormMarkdown } from '../../FormMarkdown';
import { isRecommendedOption, stripRecommendedMarker } from '../../formSerializers';
import { type FormValues, initialFormValues, valueOf, visibleFields } from '../../formCardState';
import { answersFromFormValues, formValuesFromAnswers } from '../../questionAnswers';

// The view of a question tool row, kept free of app stores so it renders on
// its own; `QuestionToolDetails` reads the stores and passes in what it needs.

export interface QuestionToolDetailsViewProps {
    prompts: readonly QuestionPrompt[];
    /** What the call returned, by question; null when it returned nothing. */
    answers: readonly QuestionAnswer[] | null;
    /** Why the call ended without answers, as OpenCode reported it. */
    errorText: string | null;
    canAnswer: boolean;
    /** The answers the form opens with, read each time it opens: the last ones given here, else the call's. */
    startingAnswers: () => readonly QuestionAnswer[] | null;
    /** Called with the form's answers when it closes without sending. */
    onKeep: (answers: QuestionAnswer[]) => void;
    onSend: (answers: QuestionAnswer[]) => void;
    /** Enter sends from a text box only off mobile, where it starts a new line instead. */
    isMobile: boolean;
    /** Wraps the questions in the row's scroll box, which stops growing at a share of the window's height. */
    renderScrollBox: (questions: React.ReactNode) => React.ReactNode;
}

// The buttons sit under the scroll box, so they stay in reach however long the
// questions are. The box pads its content with `p-2`, and the same padding
// here lines the buttons up with the questions above them.
const BUTTON_ROW_CLASS = 'px-2 pb-2';

export function QuestionToolDetailsView({ prompts, answers, errorText, canAnswer, startingAnswers, onKeep, onSend, isMobile, renderScrollBox }: QuestionToolDetailsViewProps) {
    const { t } = useI18n();
    // The answers the open form started from, null while it is closed. The
    // click that opens it reads them, since the React Compiler caches a call
    // made during render on the identity of `startingAnswers`, which stays the
    // same, and a second opening would get the first one's answers.
    const [opened, setOpened] = React.useState<{ starting: readonly QuestionAnswer[] | null } | null>(null);

    if (opened && canAnswer) {
        return (
            <QuestionAnswerForm
                prompts={prompts}
                starting={opened.starting}
                isMobile={isMobile}
                renderScrollBox={renderScrollBox}
                onCancel={(kept) => {
                    onKeep(kept);
                    setOpened(null);
                }}
                onSend={(sent) => {
                    onSend(sent);
                    setOpened(null);
                }}
            />
        );
    }

    return (
        <div>
            {renderScrollBox(
                <div className="space-y-2">
                    <ol className="space-y-3">
                        {prompts.map((prompt, index) => (
                            <QuestionSummary key={index} prompt={prompt} answer={answers ? answers[index] ?? [] : null} />
                        ))}
                    </ol>
                    {errorText ? (
                        <p className="typography-micro text-muted-foreground">
                            {t('chat.questionAnswers.notAnswered')} · {errorText}
                        </p>
                    ) : null}
                </div>,
            )}
            {canAnswer ? (
                <div className={BUTTON_ROW_CLASS}>
                    <Button variant="outline" size="xs" onClick={() => setOpened({ starting: startingAnswers() })}>
                        <Icon name="question" className="size-3.5" />
                        {answers ? t('chat.questionAnswers.answerAgain') : t('chat.questionAnswers.answer')}
                    </Button>
                </div>
            ) : null}
        </div>
    );
}

/** One question as asked, with the options chosen marked; `answer` null means the call returned none. */
function QuestionSummary({ prompt, answer }: { prompt: QuestionPrompt; answer: QuestionAnswer | null }) {
    const { t } = useI18n();
    const optionLabels = new Set(prompt.options.map((option) => option.label));
    const typed = (answer ?? []).filter((entry) => !optionLabels.has(entry));
    // Drawn like the options of the question dock, so a question reads the
    // same before and after its call ended: a chosen row takes the dock's
    // selection fill and a check, the others stay flat.
    return (
        <li className="space-y-1">
            {prompt.header ? <div className="typography-micro text-muted-foreground">{prompt.header}</div> : null}
            <FormMarkdown content={prompt.question} size="meta" className="text-foreground" />
            {prompt.options.length > 0 ? (
                <ul className="space-y-0.5">
                    {prompt.options.map((option) => {
                        const chosen = answer?.includes(option.label) ?? false;
                        return (
                            <li key={option.label} className={cn('rounded px-1.5 py-1', chosen ? 'bg-interactive-selection/20' : null)}>
                                <div className="flex items-center gap-2">
                                    <Icon name="check" className={cn('size-3.5 shrink-0 text-foreground', chosen ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
                                    <span className={cn('typography-meta min-w-0 break-words', chosen ? 'text-foreground' : 'text-foreground/80')}>
                                        {stripRecommendedMarker(option.label)}
                                    </span>
                                    {isRecommendedOption(option.label) ? (
                                        <span className="typography-micro shrink-0 text-primary/80">{t('chat.questionCard.recommended')}</span>
                                    ) : null}
                                    {chosen ? <span className="sr-only">{t('chat.questionAnswers.chosen')}</span> : null}
                                </div>
                                {option.description ? (
                                    <div className="typography-micro break-words ps-[22px] text-muted-foreground">{option.description}</div>
                                ) : null}
                            </li>
                        );
                    })}
                </ul>
            ) : null}
            {typed.map((entry, index) => (
                <div key={index} className="rounded bg-interactive-selection/20 px-1.5 py-1">
                    <div className="typography-micro text-muted-foreground">{t('chat.questionAnswers.ownAnswer')}</div>
                    <div className="typography-meta whitespace-pre-wrap break-words text-foreground">{entry}</div>
                </div>
            ))}
            {answer !== null && answer.length === 0 ? (
                <div className="typography-micro text-muted-foreground">{t('chat.questionAnswers.notAnswered')}</div>
            ) : null}
        </li>
    );
}

/** The questions as a form, filled with `starting` when there are answers to start from. */
export function QuestionAnswerForm({
    prompts,
    starting,
    isMobile,
    renderScrollBox,
    onCancel,
    onSend,
}: {
    prompts: readonly QuestionPrompt[];
    starting: readonly QuestionAnswer[] | null;
    isMobile: boolean;
    renderScrollBox: QuestionToolDetailsViewProps['renderScrollBox'];
    onCancel: (kept: QuestionAnswer[]) => void;
    onSend: (sent: QuestionAnswer[]) => void;
}) {
    const { t } = useI18n();
    const fields = React.useMemo(() => questionFormFields(prompts), [prompts]);
    const [values, setValues] = React.useState<FormValues>(() => (
        starting ? formValuesFromAnswers(fields, starting) : initialFormValues(fields)
    ));
    const shown = React.useMemo(() => visibleFields(fields, values), [fields, values]);
    const answers = React.useMemo(() => answersFromFormValues(fields, values), [fields, values]);
    const anyAnswered = answers.some((answer) => answer.length > 0);

    const updateValue = React.useCallback((key: string, patch: Partial<FormValues[string]>) => {
        setValues((previous) => ({ ...previous, [key]: { ...valueOf(previous, key), ...patch } }));
    }, []);

    const send = () => {
        if (anyAnswered) onSend(answers);
    };

    // Same keys as the inline form card: Enter sends from a text box on
    // desktop, Cmd/Ctrl+Enter anywhere; Shift+Enter starts a new line.
    const handleTextKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (isIMECompositionEvent(event)) return;
        if (event.key === 'Enter' && !event.shiftKey && (!isMobile || event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            send();
        }
    };

    return (
        <div>
            {renderScrollBox(
                <div className="space-y-2">
                    <div className="space-y-1">
                        {shown.map((field) => (
                            <FormFieldControl
                                key={field.key}
                                field={field}
                                values={values}
                                missing={[]}
                                showErrors={false}
                                isResponding={false}
                                updateValue={updateValue}
                                onTextKeyDown={handleTextKeyDown}
                            />
                        ))}
                    </div>
                    <p className="typography-micro text-muted-foreground">{t('chat.questionAnswers.sendHint')}</p>
                </div>,
            )}
            <div className={cn('flex items-center justify-end gap-1.5', BUTTON_ROW_CLASS)}>
                <Button variant="ghost" size="xs" onClick={() => onCancel(answers)}>
                    {t('chat.questionAnswers.cancel')}
                </Button>
                <Button size="xs" disabled={!anyAnswered} onClick={send}>
                    <Icon name="send-plane-2" className="size-3.5" />
                    {t('chat.questionAnswers.send')}
                </Button>
            </div>
        </div>
    );
}
