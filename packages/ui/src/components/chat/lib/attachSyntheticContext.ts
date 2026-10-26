/**
 * Folds the non-conversation messages OpenCode v2 injects around a prompt back
 * into the timeline the user reads.
 *
 * A send delivers each composer context item (an inline comment, terminal
 * output, a failed PR check, a linked issue) as its own `synthetic` message
 * right before the prompt, carrying the structured payload in its metadata.
 * Server plugins inject `synthetic` messages too, with no metadata; those are
 * prompt plumbing the user never wrote.
 *
 * So: the contiguous run of synthetic messages immediately before a user
 * message belongs to that message, and so does context right after it whose id
 * was minted before the prompt's (see the loop). The ones carrying context metadata come
 * back as text parts on the user message, which is exactly where v1 kept them,
 * so they render as context chips inside the user bubble. A background report
 * stays as its own entry. A notice that splits a turn between two answers
 * stays too (`createNoticeTurnSplitter`): turn projection opens the later
 * answer's turn at it, and it renders as its notice row or as nothing.
 *
 * A session notice (`@/lib/opencode/session-notices`) that lands while the
 * agent works becomes a row of the step it followed, the final one included
 * once it answered, or of the run's first step when it came before any; until
 * that step arrives it stays an entry that turn projection keeps in the
 * prompt's turn (`TurnRecord.waitingNotices`). One that lands after an answer
 * stays as its own entry and renders as a notice row between turns. Everything else the timeline never shows is dropped here
 * instead of rendering as an empty row.
 */

import type { Part, TextPart } from '@/lib/opencode/model';
import { readContextPart } from '@/lib/messages/contextParts';
import { readSessionNotice, sessionNoticePart, type SessionNotice, type SessionNoticePlacement } from '@/lib/opencode/session-notices';

import { createNoticeTurnSplitter, isSkippedTimelineRole, isBackgroundReportEntry } from './timelineRoles';
import type { ChatMessageEntry } from './turns/types';

const contextPartFromSyntheticMessage = (message: ChatMessageEntry): TextPart => {
    const info = message.info;
    const text = info.role === 'synthetic' ? info.text : '';
    return {
        id: `ctx:${info.id}`,
        sessionID: info.sessionID,
        messageID: info.id,
        type: 'text',
        text,
        metadata: info.metadata,
    };
};

/**
 * Merged user entries are cached by their source entry so an unchanged message
 * keeps its identity across renders: turn projection reuses a turn only while
 * its user message is the same object.
 */
type MergedEntry = { contextParts: Part[]; merged: ChatMessageEntry };
const mergedByUserEntry = new WeakMap<ChatMessageEntry, MergedEntry>();

const sameParts = (left: Part[], right: Part[]): boolean => {
    if (left.length !== right.length) return false;
    return left.every((part, index) => part === right[index]);
};

const withContextParts = (message: ChatMessageEntry, contextParts: Part[]): ChatMessageEntry => {
    const cached = mergedByUserEntry.get(message);
    if (cached && sameParts(cached.contextParts, contextParts)) {
        return cached.merged;
    }
    const merged: ChatMessageEntry = { ...message, parts: [...contextParts, ...message.parts] };
    mergedByUserEntry.set(message, { contextParts, merged });
    return merged;
};

/**
 * Assistant steps with notice rows, cached by their source entry like merged
 * user entries, so an unchanged step keeps its identity across renders.
 */
type StepWithNotices = { before: Part[]; after: Part[]; merged: ChatMessageEntry };
const stepsByEntry = new WeakMap<ChatMessageEntry, StepWithNotices>();

const withNoticeParts = (message: ChatMessageEntry, before: Part[], after: Part[]): ChatMessageEntry => {
    if (before.length === 0 && after.length === 0) return message;
    const cached = stepsByEntry.get(message);
    if (cached && sameParts(cached.before, before) && sameParts(cached.after, after)) {
        return cached.merged;
    }
    const merged: ChatMessageEntry = { ...message, parts: [...before, ...message.parts, ...after] };
    stepsByEntry.set(message, { before, after, merged });
    return merged;
};

/** Notice rows built from one notice message, cached by that message and the step it joins. */
const noticePartByEntry = new WeakMap<ChatMessageEntry, { ownerMessageID: string; placement: SessionNoticePlacement; part: Part }>();

const noticePartFor = (
    message: ChatMessageEntry,
    notice: SessionNotice,
    ownerMessageID: string,
    placement: SessionNoticePlacement,
): Part => {
    const cached = noticePartByEntry.get(message);
    if (cached && cached.ownerMessageID === ownerMessageID && cached.placement === placement) return cached.part;
    const part = sessionNoticePart(message.info, notice, ownerMessageID, placement);
    noticePartByEntry.set(message, { ownerMessageID, placement, part });
    return part;
};

/**
 * Whether a step was still running when something arrived at `at`: it has not
 * answered, or it answered later. A notice that lands during the final step
 * belongs to it even after that step finishes.
 */
const stepWasRunningAt = (step: ChatMessageEntry, at: number): boolean => {
    const info = step.info;
    if (info.role !== 'assistant' || info.finish !== 'stop') return true;
    return info.time.completed !== undefined && at <= info.time.completed;
};

/**
 * Whether a step had not finished at `at`, whatever it finished with. A step
 * with an outcome but no end time counts as finished, so a step left without
 * one in history never takes the notices of later prompts.
 */
const stepRanAt = (step: ChatMessageEntry, at: number): boolean => {
    const info = step.info;
    if (info.role !== 'assistant') return false;
    if (info.time.completed === undefined) return info.finish === undefined && info.error === undefined;
    return at <= info.time.completed;
};

/** Context parts built from one synthetic message, cached by that message. */
const contextPartBySyntheticEntry = new WeakMap<ChatMessageEntry, Part>();

/** A step in the result with the notice rows it carries; `folded` maps each notice's index to its row. */
type StepRows = { index: number; source: ChatMessageEntry; before: Part[]; after: Part[]; folded: Map<number, Part> };

export const attachSyntheticContext = (messages: ChatMessageEntry[]): ChatMessageEntry[] => {
    if (!messages.some((message) => isSkippedTimelineRole(message.info.role))) {
        return messages;
    }

    const result: ChatMessageEntry[] = [];
    let pendingContext: Part[] = [];
    // The last user message, while only invisible records follow it.
    let openUser: { index: number; source: ChatMessageEntry; contextParts: Part[] } | null = null;
    // The run's latest step.
    let lastStep: StepRows | null = null;
    // A step still running when a prompt was queued behind it: the notices
    // it raises go on landing on it, not on the queued prompt.
    let queuedOverStep: StepRows | null = null;
    // Notices with no step to join yet, in the order they came.
    let pendingNotices: Array<{ message: ChatMessageEntry; notice: SessionNotice; index: number }> = [];
    const splitAtNotice = createNoticeTurnSplitter();

    // Notices that found no step stay as entries of their own, where they came.
    const flushPendingNotices = () => {
        for (const pending of pendingNotices) result.push(pending.message);
        pendingNotices = [];
    };
    const endRun = () => {
        flushPendingNotices();
        lastStep = null;
        queuedOverStep = null;
    };

    for (const [index, message] of messages.entries()) {
        const role = message.info.role;
        const noticeIndex = splitAtNotice(message.info, index);

        if (isBackgroundReportEntry(message.info)) {
            endRun();
            pendingContext = [];
            openUser = null;
            result.push(message);
            continue;
        }

        if (role === 'synthetic' && readContextPart({ type: 'text', metadata: message.info.metadata })) {
            let part = contextPartBySyntheticEntry.get(message);
            if (!part) {
                part = contextPartFromSyntheticMessage(message);
                contextPartBySyntheticEntry.set(message, part);
            }
            // A send mints its context ids before the prompt's. While the
            // prompt is still optimistic it carries the client's clock and
            // the server's context records can land just after it; an id
            // below the prompt's still names that prompt as the owner.
            // Echoes arrive one by one, so the records already echoed sit
            // after the prompt while the rest still sit before it: the ids,
            // minted in send order, restore the order the user attached.
            if (openUser && message.info.id < openUser.source.info.id) {
                openUser.contextParts = [...openUser.contextParts, part]
                    .sort((left, right) => (left.messageID < right.messageID ? -1 : 1));
                result[openUser.index] = withContextParts(openUser.source, openUser.contextParts);
            } else {
                pendingContext.push(part);
            }
            continue;
        }

        const notice = readSessionNotice(message.info);
        if (notice) {
            const created = message.info.time.created;
            const step = lastStep && stepWasRunningAt(lastStep.source, created)
                ? lastStep
                : queuedOverStep && stepRanAt(queuedOverStep.source, created) ? queuedOverStep : null;
            if (step) {
                const part = noticePartFor(message, notice, step.source.info.id, 'after');
                step.after = [...step.after, part];
                step.folded.set(index, part);
                result[step.index] = withNoticeParts(step.source, step.before, step.after);
            } else {
                pendingNotices.push({ message, notice, index });
            }
            continue;
        }

        if (isSkippedTimelineRole(role)) continue;

        if (role === 'user') {
            const runningStep: StepRows | null = lastStep && stepRanAt(lastStep.source, message.info.time.created) ? lastStep : queuedOverStep;
            endRun();
            queuedOverStep = runningStep;
            const contextParts = pendingContext;
            pendingContext = [];
            openUser = { index: result.length, source: message, contextParts };
            result.push(contextParts.length > 0 ? withContextParts(message, contextParts) : message);
            continue;
        }

        // Anything else ends the run: context only belongs to the user message
        // it was sent with.
        pendingContext = [];
        openUser = null;
        if (role !== 'assistant') {
            endRun();
            if (noticeIndex >= 0) result.push(messages[noticeIndex]);
            result.push(message);
            continue;
        }

        // A step after an answer opens a turn at the notice before it, even
        // one the answer took while it ran; the notices before that one stay
        // between the turns. Otherwise the waiting notices open this step's rows.
        if (noticeIndex >= 0 && lastStep?.folded.has(noticeIndex)) {
            const opener = lastStep.folded.get(noticeIndex);
            lastStep.after = lastStep.after.filter((part) => part !== opener);
            result[lastStep.index] = withNoticeParts(lastStep.source, lastStep.before, lastStep.after);
        }
        const before: Part[] = [];
        for (const pending of pendingNotices) {
            if (pending.index === noticeIndex) continue;
            if (noticeIndex >= 0) result.push(pending.message);
            else before.push(noticePartFor(pending.message, pending.notice, message.info.id, 'before'));
        }
        pendingNotices = [];
        if (noticeIndex >= 0) result.push(messages[noticeIndex]);
        queuedOverStep = null;
        lastStep = { index: result.length, source: message, before, after: [], folded: new Map() };
        result.push(withNoticeParts(message, before, []));
    }

    // A notice after a prompt whose first step has not arrived stays an entry;
    // turn projection keeps it in the prompt's turn until the step takes it.
    flushPendingNotices();
    return result;
};
