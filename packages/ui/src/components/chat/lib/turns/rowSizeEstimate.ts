import type { Part } from '@/lib/opencode/model';
import { isShownInPlace } from '@/lib/opencode/tools';
import { questionEntriesForPart, questionPartSuppressed, questionSentence, selectedOptionLabels } from '../questionEntries';
import { isQuestionOpen } from '../questionExpandedState';
import { filterVisibleParts, isEmptyTextPart } from '../../message/partUtils';
import { getShownPages, hasUiBlock, isSettledAsk, type ShownPart } from './liveActivity';
import type { TimelineRow } from './timelineRows';
import type { ChatMessageEntry } from './types';

export type RowSizeMetrics = {
    columnWidth: number;
    lineHeight: number;
    showReasoningTraces: boolean;
    collapsibleThinkingBlocks: boolean;
    /** Answered question rows open with their options and answer. */
    autoExpandAnsweredQuestions: boolean;
    /** Waiting questions draw at the transcript's end, not at their call. */
    questionsInChat: boolean;
};

const TEXT_LINE_PX = 26;
const CHAR_WIDTH_PX = 16 * 0.5;
const PARAGRAPH_GAP_PX = 12;
const CODE_LINE_PX = 20;
const CODE_BLOCK_CHROME_PX = 48;
const PROMPT_CHROME_PX = 78;
const PROMPT_ATTACHMENT_PX = 66;
const EMPTY_PROMPT_PX = 40;
const DETAILED_TOOL_EXTRA_PX = 14;
const DETAILED_TOOLS = new Set(['patch', 'edit', 'write', 'subagent', 'task']);
const TURN_END_PX = 76;
const TURN_END_WITHOUT_ANSWER_PX = 8;
const FOLD_HEADER_PX = 40;
const SHOWN_PAGE_PX = 320;
const UNGROUPED_PX = 120;
const PATCH_FILE_CHIP_PX = 155;
const PATCH_FILES_EXTRA_PX = 18;
const PATCH_FILE_ROW_PX = 22;

const patchFileCount = (part: Part & { type: 'tool' }): number => {
    const files = 'metadata' in part.state ? part.state.metadata?.files : undefined;
    return Array.isArray(files) ? files.length : 0;
};

const toolHeight = (part: Part & { type: 'tool' }, metrics: RowSizeMetrics): number => {
    const files = part.tool === 'patch' ? patchFileCount(part) : 0;
    if (files > 1) {
        const perRow = Math.max(1, metrics.columnWidth / PATCH_FILE_CHIP_PX);
        return metrics.lineHeight + PATCH_FILES_EXTRA_PX + (Math.ceil(files / perRow) - 1) * PATCH_FILE_ROW_PX;
    }
    return metrics.lineHeight + (DETAILED_TOOLS.has(part.tool) ? DETAILED_TOOL_EXTRA_PX : 0);
};

const textLines = (text: string, charsPerLine: number): number => {
    let lines = 0;
    for (const line of text.split('\n')) lines += Math.max(1, Math.ceil(line.length / charsPerLine));
    return lines;
};

const markdownHeight = (text: string, columnWidth: number): number => {
    const charsPerLine = Math.max(20, Math.floor(columnWidth / CHAR_WIDTH_PX));
    let height = 0;
    const segments = text.split(/^(?:```|~~~)[^\n]*$/m);
    segments.forEach((segment, index) => {
        if (index % 2 === 1) {
            height += CODE_BLOCK_CHROME_PX + segment.trim().split('\n').length * CODE_LINE_PX;
            return;
        }
        for (const paragraph of segment.split(/\n\s*\n/)) {
            const trimmed = paragraph.trim();
            if (!trimmed) continue;
            height += textLines(trimmed, charsPerLine) * TEXT_LINE_PX + PARAGRAPH_GAP_PX;
        }
    });
    return height;
};

const sliceText = (part: Part & { type: 'text' }, row: Extract<TimelineRow, { kind: 'turn-message' }>): string => {
    const from = row.slice?.from?.partId === part.id ? row.slice.from.offset : 0;
    const to = row.slice?.to?.partId === part.id ? row.slice.to.offset : part.text.length;
    return part.text.slice(from, to);
};

const rowParts = (message: ChatMessageEntry, row: Extract<TimelineRow, { kind: 'turn-message' }>, metrics: RowSizeMetrics): Part[] => {
    const parts = filterVisibleParts(message.parts, { includeReasoning: metrics.showReasoningTraces }).filter((part) => !isEmptyTextPart(part));
    const start = row.slice?.from ? parts.findIndex((part) => part.id === row.slice?.from?.partId) : 0;
    const endCut = row.slice?.to;
    let end = parts.length;
    if (endCut) {
        const index = parts.findIndex((part) => part.id === endCut.partId);
        if (index >= 0) end = endCut.offset > 0 ? index + 1 : index;
    }
    return parts.slice(Math.max(0, start), end);
};

type TurnRowOf<K extends TimelineRow['kind']> = Extract<TimelineRow, { kind: K }>;

const hoistedPages = (row: TurnRowOf<'turn-fold' | 'turn-message' | 'turn-pages'>) => {
    if (!row.underFold) return [];
    const finalMessage = row.finalMessageId ? row.entry.turn.assistantMessages.find((message) => message.info.id === row.finalMessageId) : undefined;
    return getShownPages(row.entry.turn.assistantMessages, finalMessage, row.keepText);
};

const hoistedHeight = (pages: ShownPart[], metrics: RowSizeMetrics): number => pages.reduce((height, page) => {
    if (page.type === 'text' && !hasUiBlock(page.text)) return height + markdownHeight(page.text, metrics.columnWidth);
    return height + (page.type === 'tool' && isSettledAsk(page) ? metrics.lineHeight : SHOWN_PAGE_PX);
}, 0);

const messageRowHeight = (row: TurnRowOf<'turn-message'>, metrics: RowSizeMetrics): number | undefined => {
    const message = row.entry.turn.assistantMessages.find((candidate) => candidate.info.id === row.messageId);
    if (!message) return undefined;
    const hoisted = hoistedPages(row);
    const parts = rowParts(message, row, metrics);
    const firstText = row.final ? parts.find((part) => part.type === 'text') : undefined;
    const answerStartsHere = firstText !== undefined
        && message.parts.find((part) => part.type === 'text' && !isEmptyTextPart(part))?.id === firstText.id
        && !(row.slice?.from?.partId === firstText.id && row.slice.from.offset > 0);
    let height = answerStartsHere ? hoistedHeight(hoisted, metrics) : 0;
    let hasText = false;
    for (const part of parts) {
        // A waiting question in the chat draws at the transcript's end.
        if (questionPartSuppressed(part, metrics.questionsInChat)) continue;
        if (part.type === 'text') {
            if (hoisted.some((page) => page.id === part.id)) continue;
            hasText = true;
            height += markdownHeight(sliceText(part, row), metrics.columnWidth);
        } else if (part.type === 'reasoning') {
            if (!part.text.trim()) continue;
            height += metrics.collapsibleThinkingBlocks ? metrics.lineHeight : markdownHeight(part.text, metrics.columnWidth);
        } else if (part.type === 'tool' && isShownInPlace(part.tool, part.state)) {
            if (!hoisted.some((page) => page.id === part.id)) height += SHOWN_PAGE_PX;
        } else if (part.type === 'tool') {
            height += toolHeight(part, metrics);
        } else {
            height += metrics.lineHeight;
        }
    }
    if (row.gapBelow) height += hasText ? TURN_END_PX : TURN_END_WITHOUT_ANSWER_PX;
    return height;
};

const promptHeight = (message: ChatMessageEntry, metrics: RowSizeMetrics): number => {
    let height = 0;
    for (const part of message.parts) {
        if (part.type === 'text' && part.text.trim()) height += markdownHeight(part.text, metrics.columnWidth * 0.8) - PARAGRAPH_GAP_PX;
        else if (part.type === 'file') height += PROMPT_ATTACHMENT_PX;
    }
    return height > 0 ? PROMPT_CHROME_PX + height : EMPTY_PROMPT_PX;
};

// An answered question's card (`questionPartId`), counted from what
// `QuestionCard` draws: the row's top padding, the card's border and padding,
// and the footer's Show more link. The card is the body of the message's own
// row, so it reserves nothing for hover actions: the message's own facts and
// actions follow it, and the turn's end adds their height as it does for a
// message. Closed, one question draws its sentence and answer clamped to two
// and three lines; a batch draws one truncating line per question as far as
// its share of the screen holds (about four, then "+N more"). Open, Show more
// lists a single question's options with their descriptions, and a batch one
// question block per question with its answer. Whether it is open is the
// reader's own decision, not the setting. The line heights are the card's own
// type scale, measured in the app, not a tool row's: the chrome (row padding,
// card border and padding, Show more line) is 70 px, a question line 18, an
// answer line 19, an option's description 18.
const QUESTION_CARD_CHROME_PX = 70;
const QUESTION_CARD_QUESTION_LINE_PX = 18;
const QUESTION_CARD_ANSWER_LINE_PX = 19;
const QUESTION_CARD_ENTRY_GAP_PX = 2;
const QUESTION_CARD_BATCH_ROW_GAP_PX = 4;
const QUESTION_CARD_ROWS = 4;
const QUESTION_CARD_MORE_PX = 24;
const QUESTION_CARD_GAP_PX = 10;
const QUESTION_CARD_OPTIONS_TOP_PX = 4;
const QUESTION_CARD_OPTION_PX = 19;
const QUESTION_CARD_OPTION_GAP_PX = 6;
const QUESTION_CARD_DESCRIPTION_LINE_PX = 18;

const questionCardHeight = (row: TurnRowOf<'turn-message'>, metrics: RowSizeMetrics): number | undefined => {
    const message = row.entry.turn.assistantMessages.find((candidate) => candidate.info.id === row.messageId);
    const part = message?.parts.find((candidate) => candidate.id === row.questionPartId);
    if (part?.type !== 'tool') return undefined;
    const entries = questionEntriesForPart(part, part.messageID);
    const charsPerLine = Math.max(20, Math.floor(metrics.columnWidth / CHAR_WIDTH_PX));
    const clampedLines = (text: string, max: number) => Math.min(max, textLines(text, charsPerLine));
    const open = isQuestionOpen(part.id, metrics.autoExpandAnsweredQuestions);
    if (entries.length > 1 && !open) {
        const rows = Math.min(entries.length, QUESTION_CARD_ROWS);
        let height = QUESTION_CARD_CHROME_PX;
        for (const entry of entries.slice(0, rows)) {
            const answerLines = entry.answer ? clampedLines(entry.answer, 2) : 1;
            height += Math.max(QUESTION_CARD_QUESTION_LINE_PX, answerLines * QUESTION_CARD_ANSWER_LINE_PX) + QUESTION_CARD_BATCH_ROW_GAP_PX;
        }
        return height + (entries.length > rows ? QUESTION_CARD_MORE_PX : 0);
    }
    let height = QUESTION_CARD_CHROME_PX;
    for (const [index, entry] of entries.entries()) {
        if (index > 0) height += QUESTION_CARD_GAP_PX;
        height += clampedLines(questionSentence(entry.question), 2) * QUESTION_CARD_QUESTION_LINE_PX;
        if (open && entries.length === 1) {
            height += QUESTION_CARD_OPTIONS_TOP_PX;
            for (const option of entry.options) {
                height += QUESTION_CARD_OPTION_PX + QUESTION_CARD_OPTION_GAP_PX;
                if (option.description) height += clampedLines(option.description, Number.POSITIVE_INFINITY) * QUESTION_CARD_DESCRIPTION_LINE_PX;
            }
            // A typed answer draws one more marked row under the options.
            if (entry.answer && selectedOptionLabels(entry.options, entry.answer, entry.multiple).size === 0) {
                height += QUESTION_CARD_ANSWER_LINE_PX;
            }
            continue;
        }
        height += QUESTION_CARD_ENTRY_GAP_PX;
        height += entry.answer
            ? clampedLines(entry.answer, open ? Number.POSITIVE_INFINITY : 3) * QUESTION_CARD_ANSWER_LINE_PX
            : QUESTION_CARD_QUESTION_LINE_PX;
    }
    return height;
};

export const estimateTimelineRowSize = (row: TimelineRow, metrics: RowSizeMetrics): number | undefined => {
    if (metrics.columnWidth <= 0) return undefined;
    let height: number;
    switch (row.kind) {
        case 'ungrouped': return UNGROUPED_PX;
        case 'turn-head': height = promptHeight(row.entry.turn.userMessage, metrics); break;
        case 'turn-fold': height = FOLD_HEADER_PX + (row.keepText && !row.finalMessageId ? hoistedHeight(hoistedPages(row), metrics) : 0); break;
        case 'turn-pages': height = hoistedHeight(hoistedPages(row), metrics); break;
        case 'turn-message': {
            if (row.questionPartId) {
                const card = questionCardHeight(row, metrics);
                if (card === undefined) return undefined;
                // The message keeps its own facts and actions under the card,
                // so its end adds what a message row's end adds.
                const message = row.entry.turn.assistantMessages.find((candidate) => candidate.info.id === row.messageId);
                const hasText = message?.parts.some((part) => part.type === 'text' && !isEmptyTextPart(part)) ?? false;
                return Math.round(card + (row.gapBelow ? (hasText ? TURN_END_PX : TURN_END_WITHOUT_ANSWER_PX) : 0));
            }
            const message = messageRowHeight(row, metrics);
            return message === undefined ? undefined : Math.round(message);
        }
    }
    return Math.round(height + (row.gapBelow ? TURN_END_PX : 0));
};
