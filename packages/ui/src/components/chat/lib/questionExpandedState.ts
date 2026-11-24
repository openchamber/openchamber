import React from 'react';

import type { Part } from '@/lib/opencode/model';
import { isQuestionTool } from '@/lib/opencode/tools';

/**
 * Which tool rows a message opens with, and whether a question row is open.
 *
 * A question row's open state is only ever the reader's: the transcript card,
 * a closed fold's preview and every other renderer of the same part read one
 * map here, so a card the reader closed stays closed wherever it is drawn.
 * Absent a decision, the row follows `autoExpandAnsweredQuestions`.
 *
 * The caches are keyed by message or part id and survive session switches
 * until a reload or the 4000-entry trim.
 */
const EXPANDED_TOOLS_CACHE_MAX = 4000;
const expandedToolsStateCache = new Map<string, Set<string>>();
// The reader's own decision for a question row, by part id: open or closed.
const questionOpenChoices = new Map<string, boolean>();
const questionOpenListeners = new Set<() => void>();
let questionOpenRevision = 0;

const trimCache = (cache: Map<string, unknown>, key: string): void => {
    if (cache.size >= EXPANDED_TOOLS_CACHE_MAX && !cache.has(key)) {
        const oldest = cache.keys().next().value;
        if (typeof oldest === 'string') {
            cache.delete(oldest);
        }
    }
};

const readExpandedToolsCache = (messageId: string): Set<string> | undefined => {
    const cached = expandedToolsStateCache.get(messageId);
    return cached ? new Set(cached) : undefined;
};

export const writeExpandedToolsCache = (messageId: string, value: Set<string>): void => {
    trimCache(expandedToolsStateCache, messageId);
    expandedToolsStateCache.set(messageId, new Set(value));
};

const notifyQuestionOpen = (): void => {
    questionOpenRevision += 1;
    for (const listener of questionOpenListeners) listener();
};

/** A subscription to every question row's open state; rows read their own part. */
export const subscribeQuestionOpen = (listener: () => void): (() => void) => {
    questionOpenListeners.add(listener);
    return () => {
        questionOpenListeners.delete(listener);
    };
};

/**
 * A value that changes with any question row's open state. A size estimate
 * keys on it so a row the reader toggled is estimated at the shape it draws.
 */
export const readQuestionOpenRevision = (): number => questionOpenRevision;

/** Whether a question row is open; without a decision it follows the setting. */
export const isQuestionOpen = (partId: string, autoExpandAnsweredQuestions: boolean): boolean =>
    questionOpenChoices.get(partId) ?? autoExpandAnsweredQuestions;

/** The parts among `partIds` drawn open, as a snapshot a subscriber compares. */
export const openQuestionSnapshot = (
    partIds: readonly string[],
    autoExpandAnsweredQuestions: boolean,
): string => partIds.filter((partId) => isQuestionOpen(partId, autoExpandAnsweredQuestions)).join('\u0000');

/** Record the reader's decision for a question row and re-render its renderers. */
export const writeQuestionOpen = (partId: string, open: boolean): void => {
    if (questionOpenChoices.get(partId) === open) return;
    trimCache(questionOpenChoices, partId);
    questionOpenChoices.set(partId, open);
    notifyQuestionOpen();
};

/** The question row's own open state, shared by every renderer of the part. */
export const useQuestionOpen = (partId: string, autoExpandAnsweredQuestions: boolean): boolean => {
    const read = () => isQuestionOpen(partId, autoExpandAnsweredQuestions);
    return React.useSyncExternalStore(subscribeQuestionOpen, read, read);
};

export const questionIds = (parts: readonly Part[]): Set<string> =>
    new Set(parts.filter((part) => part.type === 'tool' && isQuestionTool(part.tool)).map((part) => part.id));

/** The tool rows a message opens with, besides its question rows. */
export const seedExpandedTools = (messageId: string, parts: readonly Part[]): Set<string> => {
    const cached = readExpandedToolsCache(messageId);
    const expanded = cached ? new Set(cached) : new Set<string>();
    for (const id of questionIds(parts)) expanded.delete(id);
    return expanded;
};
