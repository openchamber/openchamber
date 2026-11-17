
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

const stepWasRunningAt = (step: ChatMessageEntry, at: number): boolean => {
    const info = step.info;
    if (info.role !== 'assistant' || info.finish !== 'stop') return true;
    return info.time.completed !== undefined && at <= info.time.completed;
};

const stepRanAt = (step: ChatMessageEntry, at: number): boolean => {
    const info = step.info;
    if (info.role !== 'assistant') return false;
    if (info.time.completed === undefined) return info.finish === undefined && info.error === undefined;
    return at <= info.time.completed;
};

const contextPartBySyntheticEntry = new WeakMap<ChatMessageEntry, Part>();

type StepRows = { index: number; source: ChatMessageEntry; before: Part[]; after: Part[]; folded: Map<number, Part> };

export const attachSyntheticContext = (messages: ChatMessageEntry[]): ChatMessageEntry[] => {
    if (!messages.some((message) => isSkippedTimelineRole(message.info.role))) {
        return messages;
    }

    const result: ChatMessageEntry[] = [];
    let pendingContext: Part[] = [];
    let openUser: { index: number; source: ChatMessageEntry; contextParts: Part[] } | null = null;
    let lastStep: StepRows | null = null;
    let queuedOverStep: StepRows | null = null;
    let pendingNotices: Array<{ message: ChatMessageEntry; notice: SessionNotice; index: number }> = [];
    const splitAtNotice = createNoticeTurnSplitter();

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

        pendingContext = [];
        openUser = null;
        if (role !== 'assistant') {
            endRun();
            if (noticeIndex >= 0) result.push(messages[noticeIndex]);
            result.push(message);
            continue;
        }

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

    flushPendingNotices();
    return result;
};
