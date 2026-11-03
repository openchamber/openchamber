import type { Part } from '@/lib/opencode/model';
import { isShownInPlace } from '@/lib/opencode/tools';
import { filterVisibleParts, isEmptyTextPart } from '../../message/partUtils';
import { getShownPages } from './liveActivity';
import type { TimelineRow } from './timelineRows';
import type { ChatMessageEntry } from './types';

/**
 * The height a transcript row will have before it is measured, from what it
 * draws. The list places rows it has not measured at this height and, once
 * one above the reader is measured, moves the viewport by the difference.
 * On iOS that correction lands while the scroll's momentum runs in another
 * thread, which takes part of it back on its next frame: the text jumps by
 * the error and partly back. One estimate for every row (320 px) was off by
 * 284 px for every tool step a reader scrolled past. Built from the row's
 * parts, the error is a few lines of text at most.
 */
export type RowSizeMetrics = {
    /** Width of the chat column, where message text wraps. */
    columnWidth: number;
    /** A tool, reasoning, agent or file line (36 px on touch, taller tap targets). */
    lineHeight: number;
    showReasoningTraces: boolean;
    /** Reasoning folds to one line; off, it is drawn as text. */
    collapsibleThinkingBlocks: boolean;
};

const TEXT_LINE_PX = 26;
// Average advance of a character of the 16 px body font, as a share of it.
const CHAR_WIDTH_PX = 16 * 0.5;
const PARAGRAPH_GAP_PX = 12;
const CODE_LINE_PX = 20;
const CODE_BLOCK_CHROME_PX = 48;
// A user prompt's bubble, timestamp and the space above it.
const PROMPT_CHROME_PX = 78;
const PROMPT_ATTACHMENT_PX = 66;
// A prompt row with nothing of its own to show (its text lives elsewhere).
const EMPTY_PROMPT_PX = 40;
// An edit or a subagent run shows a second line of detail under its title.
const DETAILED_TOOL_EXTRA_PX = 14;
const DETAILED_TOOLS = new Set(['patch', 'edit', 'write', 'subagent', 'task']);
// The answer's footer (model, agent, duration) and the gap under a turn; a
// turn that ends without text has no footer.
const TURN_END_PX = 76;
const TURN_END_WITHOUT_ANSWER_PX = 8;
const FOLD_HEADER_PX = 40;
// A page or card the agent showed in place of its call.
const SHOWN_PAGE_PX = 320;
const UNGROUPED_PX = 120;
// A patch across several files lists them under its title, wrapping in rows
// of chips about this wide.
const PATCH_FILE_CHIP_PX = 155;
const PATCH_FILES_EXTRA_PX = 18;
const PATCH_FILE_ROW_PX = 22;

// The files a multi-file patch lists, as its row draws them (`ApplyPatchFileButtons`).
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

/** Height of Markdown text at the column's width: prose wraps, code does not. */
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

// The parts one row of a message draws, in the order `messageCuts` cuts them.
const rowParts = (message: ChatMessageEntry, row: Extract<TimelineRow, { kind: 'turn-message' }>, metrics: RowSizeMetrics): Part[] => {
    const parts = filterVisibleParts(message.parts, { includeReasoning: metrics.showReasoningTraces }).filter((part) => !isEmptyTextPart(part));
    const start = row.slice?.from ? parts.findIndex((part) => part.id === row.slice?.from?.partId) : 0;
    const endCut = row.slice?.to;
    let end = parts.length;
    if (endCut) {
        const index = parts.findIndex((part) => part.id === endCut.partId);
        // A cut inside a text part keeps that part's head in this row.
        if (index >= 0) end = endCut.offset > 0 ? index + 1 : index;
    }
    return parts.slice(Math.max(0, start), end);
};

type TurnRowOf<K extends TimelineRow['kind']> = Extract<TimelineRow, { kind: K }>;

// Under a fold the pages the turn showed leave their steps: the final answer
// draws them above itself, or a row of their own does (`useTurnFold`).
const hoistedPages = (row: TurnRowOf<'turn-message' | 'turn-pages'>) => {
    if (!row.underFold) return [];
    const finalMessage = row.finalMessageId ? row.entry.turn.assistantMessages.find((message) => message.info.id === row.finalMessageId) : undefined;
    return getShownPages(row.entry.turn.assistantMessages, finalMessage);
};

const messageRowHeight = (row: TurnRowOf<'turn-message'>, metrics: RowSizeMetrics): number | undefined => {
    const message = row.entry.turn.assistantMessages.find((candidate) => candidate.info.id === row.messageId);
    if (!message) return undefined;
    const hoisted = hoistedPages(row);
    const parts = rowParts(message, row, metrics);
    // The final answer draws the hoisted pages right above its first text,
    // in the row where that text starts.
    const firstText = row.final ? parts.find((part) => part.type === 'text') : undefined;
    const answerStartsHere = firstText !== undefined
        && message.parts.find((part) => part.type === 'text' && !isEmptyTextPart(part))?.id === firstText.id
        && !(row.slice?.from?.partId === firstText.id && row.slice.from.offset > 0);
    let height = answerStartsHere ? hoisted.length * SHOWN_PAGE_PX : 0;
    let hasText = false;
    for (const part of parts) {
        if (part.type === 'text') {
            if (hoisted.some((page) => page.id === part.id)) continue;
            hasText = true;
            height += markdownHeight(sliceText(part, row), metrics.columnWidth);
        } else if (part.type === 'reasoning') {
            // Reasoning the model kept to itself draws nothing.
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

export const estimateTimelineRowSize = (row: TimelineRow, metrics: RowSizeMetrics): number | undefined => {
    if (metrics.columnWidth <= 0) return undefined;
    let height: number;
    switch (row.kind) {
        case 'ungrouped': return UNGROUPED_PX;
        case 'turn-head': height = promptHeight(row.entry.turn.userMessage, metrics); break;
        case 'turn-fold': height = FOLD_HEADER_PX; break;
        case 'turn-pages': height = hoistedPages(row).length * SHOWN_PAGE_PX; break;
        case 'turn-message': {
            const message = messageRowHeight(row, metrics);
            return message === undefined ? undefined : Math.round(message);
        }
    }
    return Math.round(height + (row.gapBelow ? TURN_END_PX : 0));
};
