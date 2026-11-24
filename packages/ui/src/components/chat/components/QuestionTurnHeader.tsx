import React from 'react';

import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { hasTextSelectionInside } from '@/lib/textSelection';
import { Icon } from '@/components/icon/Icon';
import type { Part } from '@/lib/opencode/model';
import { useUIStore } from '@/stores/useUIStore';
import {
    questionCardState,
    questionEntriesForPart,
    questionEntryState,
    questionPartSuppressed,
    questionStateKey,
    questionSentence,
    selectedOptionLabels,
    withoutRecommendationPicks,
    type QuestionAnswerEntry,
    type QuestionCardState,
} from '../lib/questionEntries';
import { STICKY_ROW_OFFSET, STICKY_ROW_OFFSET_EVENT } from '../lib/turns/stickyPrompt';
import { useQuestionOpen, writeQuestionOpen } from '../lib/questionExpandedState';
import { FormDockModeContext } from '../formsInChat';
import { stickyHeaderBackground } from './stickyHeaderBackground';
import { USER_BUBBLE_TEXT_LINK_CLASS } from '../message/body/userBubbleLinkStyle';
import { USER_BUBBLE_SHELL_CLASS, userBubbleStyle, userBubbleTintedFill } from '../message/body/userBubbleStyle';
import { QuestionAnswerLine, QuestionAnswerRow, QuestionOptionRow } from '../message/parts/QuestionChoices';

const RAIL_STYLE: React.CSSProperties = { borderColor: 'var(--status-question)' };

// The prompt bubble with the question colour mixed into its own fill, so the
// card is the same shape and reads as the row's purple sibling instead of a
// copy that drifted. Mixing into `--chat-user-message-bg` is what keeps it
// opaque: the old fill mixed the question's own tint, which is already
// translucent, so the card came out near-clear and the transcript read
// through it and through the bar that covers the chat while the card is open.
const CARD_STYLE: React.CSSProperties = userBubbleStyle(
    userBubbleTintedFill('--status-question'),
);

const LINK_STYLE: React.CSSProperties = { minHeight: 0, minWidth: 0 };

/** The share of the screen's height a batch's collapsed list may take. */
const COLLAPSED_LIST_SHARE = 0.15;
/** Room for the "+N more" line under a cut list. */
const MORE_LINE_PX = 24;
/** The bar takes over once less than this much of a scrolled-away card is in view. */
const BAR_HANDOVER_PX = 40;

interface AnsweredEntry {
    entry: QuestionAnswerEntry;
    /** The answer as shown, or empty when the question went unanswered. */
    answer: string;
    /**
     * Where this question stands, which is not always where its call does: a
     * call that got an answer for one of its questions is answered, and the
     * question it left blank is not.
     */
    state: QuestionCardState;
}

/**
 * Hides the rows of a collapsed list that do not fit its share of the screen
 * and returns how many it hid. Rows stay laid out (hidden, the list clipped
 * under the last shown one) so the next measure still sees them.
 */
const useCollapsedRows = (listRef: React.RefObject<HTMLDivElement | null>, enabled: boolean, rowsKey: unknown): number => {
    const [hidden, setHidden] = React.useState(0);
    React.useLayoutEffect(() => {
        const list = listRef.current;
        if (!enabled || !list) {
            // Opening clears what the collapse hid: the rows carry inline
            // visibility and the list an inline height, and neither is undone by
            // re-rendering alone, so an opened card kept its rows invisible.
            if (list) {
                for (const row of list.querySelectorAll<HTMLElement>('[data-question-row]')) {
                    row.style.visibility = '';
                }
                list.style.height = '';
            }
            setHidden(0);
            return;
        }
        const measure = () => {
            const rows = [...list.querySelectorAll<HTMLElement>('[data-question-row]')];
            const fitting = (budget: number) => {
                let shown = 0;
                for (const row of rows) {
                    if (row.offsetTop + row.offsetHeight > budget) break;
                    shown += 1;
                }
                return shown;
            };
            const budget = window.innerHeight * COLLAPSED_LIST_SHARE;
            let shown = fitting(budget);
            if (shown < rows.length) shown = Math.max(1, fitting(budget - MORE_LINE_PX));
            rows.forEach((row, index) => { row.style.visibility = index < shown ? '' : 'hidden'; });
            const last = rows[shown - 1];
            list.style.height = shown < rows.length && last ? `${last.offsetTop + last.offsetHeight}px` : '';
            setHidden(rows.length - shown);
        };
        measure();
        // A narrower column wraps more answers; a shorter screen fits fewer rows.
        let width = list.offsetWidth;
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
            if (list.offsetWidth === width) return;
            width = list.offsetWidth;
            measure();
        });
        observer?.observe(list);
        window.addEventListener('resize', measure);
        return () => {
            observer?.disconnect();
            window.removeEventListener('resize', measure);
            list.style.height = '';
        };
    }, [enabled, listRef, rowsKey]);
    return hidden;
};

/**
 * Whether a pinned batch card has scrolled away far enough for its bar. The
 * list moves the pinned row off its place by `STICKY_ROW_OFFSET`; the card
 * draws itself back there, so it scrolls away with the transcript.
 *
 * The offset is read from the row the list reports, never from the element's
 * inherited value on mount: the list reuses a row's container for whatever
 * scrolls in next, and the offset it still carries would hand the new row a
 * phantom one.
 */
const useBarHandover = (enabled: boolean) => {
    const flowRef = React.useRef<HTMLDivElement>(null);
    const [covered, setCovered] = React.useState(false);
    React.useEffect(() => {
        const flow = flowRef.current;
        const chat = flow?.closest<HTMLElement>('[data-scrollbar="chat"]');
        if (!enabled || !flow || !chat) {
            setCovered(false);
            return;
        }
        const check = (row: HTMLElement) => {
            const offset = Number.parseFloat(row.style.getPropertyValue(STICKY_ROW_OFFSET)) || 0;
            setCovered(offset > 0 && offset > flow.offsetHeight - BAR_HANDOVER_PX);
        };
        const onOffset = (event: Event) => {
            if (event.target instanceof HTMLElement && event.target.contains(flow)) check(event.target);
        };
        chat.addEventListener(STICKY_ROW_OFFSET_EVENT, onOffset);
        return () => chat.removeEventListener(STICKY_ROW_OFFSET_EVENT, onOffset);
    }, [enabled]);
    return { flowRef, covered };
};

interface QuestionCardProps {
    answered: readonly AnsweredEntry[];
    open: boolean;
    onToggle: () => void;
    /** Where the card is drawn; the message's column and gap are the caller's. */
    placement: 'row' | 'preview';
    isMobile: boolean;
}

/**
 * The purple card. Collapsed, one question shows its sentence and answer and
 * a batch one line per question (label and answer) as far as fits. Show more
 * opens one question straight to its options; a batch first lists every
 * question with its answer, and Show options then opens every option.
 */
const QuestionCard: React.FC<QuestionCardProps> = ({
    answered, open, onToggle, placement, isMobile,
}) => {
    const { t } = useI18n();
    const listRef = React.useRef<HTMLDivElement>(null);
    // One shape for every card: a question line and its answer under it, as
    // many as fit, the rest behind one count. Neither the number of questions
    // nor the open state changes the layout.
    const hiddenRows = useCollapsedRows(listRef, !open, answered);
    const showOptions = open;
    const toggle = onToggle;

    const entryBlock = ({ entry, answer, state }: AnsweredEntry, index: number) => {
        const picked = selectedOptionLabels(entry.options, entry.answer, entry.multiple);
        return (
            <div key={`${entry.partId}:${index}`} className="min-w-0 space-y-0.5 border-s-2 ps-2.5" style={RAIL_STYLE}>
                <div dir="auto" className="flex min-w-0 items-start gap-1.5 typography-meta text-foreground/70 oc-ui-start-align" title={entry.question} data-context-icon="question">
                    <Icon name="question" className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: 'var(--status-question)' }} />
                    {/* The clamp goes on the text, not the row: line-clamp sets
                        display:-webkit-box, which beats flex and left the icon
                        stacked above the question. */}
                    <span className={cn('min-w-0', !open && 'line-clamp-1')}>{questionSentence(entry.question)}</span>
                </div>
                {showOptions ? (
                    <div className="pt-1">
                        {entry.options.map((option) => (
                            <QuestionOptionRow key={option.label} option={option} chosen={picked.has(option.label)} multiple={entry.multiple} />
                        ))}
                        {!answer ? (
                            <div className="typography-markdown italic leading-snug text-muted-foreground oc-ui-start-align">
                                {t(questionStateKey(state))}
                            </div>
                        ) : null}
                        {picked.size === 0 && answer ? (
                            <QuestionAnswerRow multiple={entry.multiple}>
                                <QuestionAnswerLine answer={answer} />
                            </QuestionAnswerRow>
                        ) : null}
                    </div>
                ) : answer ? (
                    <div dir="auto" className={cn('whitespace-pre-wrap break-words typography-markdown font-medium leading-snug text-foreground oc-ui-start-align', !open && 'line-clamp-1')}>
                        {answer}
                    </div>
                ) : (
                    <div dir="auto" className="typography-markdown italic leading-snug text-muted-foreground oc-ui-start-align" data-question-card-state={state}>
                        {t(questionStateKey(state))}
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className={cn('relative z-10 flex flex-col items-end', placement === 'preview' ? 'py-1.5' : undefined)} data-question-turn-header="">
            <div className="max-w-[85%]">
                <div className={`select-text ${USER_BUBBLE_SHELL_CLASS}`} style={CARD_STYLE} data-question-card-bubble="">
                    <div
                        ref={listRef}
                        className={cn(
                            'space-y-2.5',
                            open ? cn(isMobile ? 'max-h-[30dvh]' : 'max-h-[40dvh]', 'overflow-y-auto overscroll-contain') : 'cursor-pointer',
                        )}
                        onClick={(event) => {
                            // Match UserTextPart: a click opens collapsed content;
                            // a drag/double-click selecting text must leave it alone.
                            // Open text never collapses on click (Show less does).
                            if (!open && !hasTextSelectionInside(event.currentTarget)) toggle();
                        }}
                    >
                        {answered.map(({ entry, answer, state }, index) => (
                            <div key={`${entry.partId}:${index}`} data-question-row="" className="mb-2.5 last:mb-0">
                                {entryBlock({ entry, answer, state }, index)}
                            </div>
                        ))}
                    </div>
                    {!open && hiddenRows > 0 ? (
                        // The count sits outside the measured list: the list's
                        // height is set to the last row that fits, so anything
                        // inside it would be clipped away.
                        <div className="mt-1 typography-meta text-muted-foreground">
                            {t('chat.questionCard.moreQuestions', { count: hiddenRows })}
                        </div>
                    ) : null}
                    <div className="mt-1 flex min-w-0 items-center justify-end gap-1.5 text-sm text-muted-foreground">
                        <button
                            type="button"
                            onClick={toggle}
                            className={cn('shrink-0', USER_BUBBLE_TEXT_LINK_CLASS)}
                            style={LINK_STYLE}
                            aria-expanded={open}
                        >
                            {t(open ? 'chat.message.userText.showLess' : 'chat.message.userText.showMore')}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

/**
 * A question call as its own transcript row: a purple card with each question
 * and the answer it got on a rail, or a line saying it went unanswered. Show
 * more opens the card in place (see `QuestionCard`). With the sticky user
 * header on, an answered card sticks like a prompt until the next prompt or
 * answered question pushes it up. A batch of questions scrolls away instead
 * and leaves a one-line bar of its answers, which opens the card where it is.
 *
 * The card is the body of the message's own row (`ChatMessage`'s body slot), so
 * the message keeps its error banner, actions and facts under it.
 */
export const QuestionTurnHeader: React.FC<{
    part: Part;
    messageId: string;
    /** Set only by a copy that is not the row, such as the bar's opened card. */
    open?: boolean;
    onToggle?: (partId: string) => void;
    /** Off in a fold's preview, where the card never sticks. */
    pinnable?: boolean;
    placement: 'row' | 'preview';
}> = ({ part, messageId, open: controlledOpen, onToggle, pinnable = true, placement }) => {
    const { isMobile } = useDeviceInfo();
    const { t } = useI18n();
    const autoExpandAnsweredQuestions = useUIStore((state) => state.autoExpandAnsweredQuestions);
    // The reader's decision is one module cache, so the transcript row and a
    // fold's preview of the same part draw the same state.
    const readerOpen = useQuestionOpen(part.id, autoExpandAnsweredQuestions);
    const open = controlledOpen ?? readerOpen;
    const toggle = React.useCallback(() => {
        if (onToggle) {
            onToggle(part.id);
            return;
        }
        writeQuestionOpen(part.id, !readerOpen);
    }, [onToggle, part.id, readerOpen]);
    const sticks = useUIStore((state) => state.stickyUserHeader);
    const formsInChat = React.useContext(FormDockModeContext) === 'in-chat';
    const entries = React.useMemo(() => questionEntriesForPart(part, messageId), [part, messageId]);
    const cardState = questionCardState(part);
    const answered = React.useMemo<AnsweredEntry[]>(
        () => entries.map((entry) => ({
            entry,
            answer: entry.answer ? withoutRecommendationPicks(entry.answer.trim()) : '',
            state: questionEntryState(entry, cardState),
        })),
        [entries, cardState],
    );
    const pinned = pinnable && sticks && cardState === 'answered';
    const barred = pinned && answered.length > 1;
    const { flowRef, covered } = useBarHandover(barred);
    const [barOpen, setBarOpen] = React.useState(false);
    React.useEffect(() => {
        if (!covered) setBarOpen(false);
    }, [covered]);

    if (answered.length === 0 || cardState === null) return null;
    // A waiting question in the chat is drawn once, by the form at the
    // transcript's end, which takes the answer.
    if (questionPartSuppressed(part, formsInChat)) return null;
    const card = (
        <QuestionCard
            answered={answered} open={open} onToggle={toggle} placement={placement} isMobile={isMobile}
        />
    );

    if (!pinned) return card;
    if (!barred) {
        return (
            <div className={cn('sticky top-0 z-20 w-full [overflow-anchor:none]', isMobile ? '-mt-2 pt-2 pb-4' : '-mt-4 pt-4 pb-9')} data-turn-sticky-header="" style={stickyHeaderBackground(isMobile)}>
                {card}
            </div>
        );
    }

    const background = stickyHeaderBackground(isMobile);
    return (
        <div
            // The card is 85% wide and right-aligned; without a full-width
            // surface behind its row the transcript it covers shows beside it.
            // The bar paints the same surface once the card scrolls away, so
            // the row always reads as one band, never a narrow bubble floating
            // over text.
            className="relative w-full [overflow-anchor:none]"
            style={background}
        >
            <div ref={flowRef} style={{ transform: `translateY(calc(-1 * var(${STICKY_ROW_OFFSET}, 0px)))` }}>
                {card}
            </div>
            {covered ? (
                // What covers the top of the chat, so it is the sticky header
                // the scroll helpers measure. The bar stays the disclosure it
                // was pressed as, so its state is announced, and the card opens
                // under it.
                <div className={cn('absolute inset-x-0 z-10', isMobile ? '-top-2' : '-top-4')} data-turn-sticky-header="" data-question-bar="" style={background}>
                    <div className={cn('chat-message-column relative', isMobile ? 'pt-4 pb-4' : 'pt-7 pb-9')}>
                        <div className="flex justify-end">
                            <button
                                type="button"
                                onClick={() => setBarOpen((shown) => !shown)}
                                aria-expanded={barOpen}
                                className="flex min-w-0 max-w-[85%] items-center gap-2 border border-primary/5 px-3 py-1.5 text-start"
                                style={CARD_STYLE}
                            >
                                <span aria-hidden="true" className="h-4 shrink-0 border-s-2" style={RAIL_STYLE} />
                                <span className="shrink-0 typography-meta text-foreground/70">
                                    {t('chat.questionCard.answerCount', { count: answered.length })}
                                </span>
                                <span dir="auto" className="min-w-0 truncate typography-markdown font-medium leading-snug text-foreground oc-ui-start-align">
                                    {answered.map(({ answer, state }) => answer || t(questionStateKey(state))).join(', ')}
                                </span>
                            </button>
                        </div>
                        {barOpen ? (
                            <QuestionCard answered={answered} open onToggle={() => setBarOpen(false)} placement="preview" isMobile={isMobile} />
                        ) : null}
                    </div>
                </div>
            ) : null}
        </div>
    );
};
