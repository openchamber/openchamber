import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@/lib/opencode/model';

import { isSessionNoticePart, readSessionNotice, sessionNoticePart } from '@/lib/opencode/session-notices';

import { buildLiveStreamingEntry, type StreamingTailEntry } from './streamingTailEntry';
import type { ChatMessageEntry, TurnRecord } from './types';

const message = (id: string, role: 'user' | 'assistant', parentID?: string, parts: Part[] = []): ChatMessageEntry => ({
    info: {
        id,
        role,
        sessionID: 'ses_1',
        ...(parentID ? { parentID } : {}),
        time: { created: 1 },
    } as Message,
    parts,
});

const textPart = (id: string, text: string): Part => ({
    id,
    type: 'text',
    text,
} as Part);

const reasoningPart = (id: string, text: string): Part => ({
    id,
    type: 'reasoning',
    text,
} as Part);

const turnEntry = (assistant: ChatMessageEntry): StreamingTailEntry => {
    const user = message('user_1', 'user');
    return {
        kind: 'turn',
        key: 'turn:user_1',
        isLastTurn: true,
        turn: {
            turnId: 'user_1',
            userMessageId: 'user_1',
            userMessage: user,
            headerMessageId: assistant.info.id,
            messages: [],
            assistantMessageIds: [assistant.info.id],
            assistantMessages: [assistant],
            activityParts: [],
            summary: {},
            hasTools: false,
            hasReasoning: false,
            stream: { isStreaming: true, isRetrying: false },
        } satisfies TurnRecord,
    };
};

describe('buildLiveStreamingEntry', () => {
    test('keeps the notice rows a step carries around its live parts', () => {
        const noticeMessage: Message = { id: 'n1', sessionID: 'ses_1', role: 'synthetic', time: { created: 1 }, text: 'wait', description: 'Waiting for quota reset' };
        const notice = readSessionNotice(noticeMessage)!;
        const before = sessionNoticePart(noticeMessage, notice, 'assistant_1', 'before');
        const after = sessionNoticePart({ ...noticeMessage, id: 'n2' }, notice, 'assistant_1', 'after');
        const assistant = message('assistant_1', 'assistant', 'user_1', [before, textPart('part_1', 'hel'), after]);
        const live = textPart('part_1', 'hello');

        const next = buildLiveStreamingEntry(turnEntry(assistant), {
            livePartsByMessageId: { assistant_1: [live] },
            showTurnChangedFiles: false,
        });

        if (next.kind !== 'turn') throw new Error('expected a turn');
        const parts = next.turn.assistantMessages[0]?.parts ?? [];
        expect(parts.map((part) => part.id)).toEqual(['notice:n1', 'part_1', 'notice:n2']);
        expect(parts.filter(isSessionNoticePart)).toHaveLength(2);
    });

    test('keeps a later notice after the live parts while the record has none of its own yet', () => {
        const noticeMessage: Message = { id: 'n1', sessionID: 'ses_1', role: 'synthetic', time: { created: 1 }, text: 'x', description: 'Loaded AGENTS.md' };
        const after = sessionNoticePart(noticeMessage, readSessionNotice(noticeMessage)!, 'assistant_1', 'after');
        const assistant = message('assistant_1', 'assistant', 'user_1', [after]);

        const next = buildLiveStreamingEntry(turnEntry(assistant), {
            livePartsByMessageId: { assistant_1: [textPart('part_live', 'read the file')] },
            showTurnChangedFiles: false,
        });

        if (next.kind !== 'turn') throw new Error('expected a turn');
        expect(next.turn.assistantMessages[0]?.parts.map((part) => part.id)).toEqual(['part_live', 'notice:n1']);
    });

    test('returns the same entry when the active message is not in the tail', () => {
        const assistant = message('assistant_1', 'assistant', 'user_1', [textPart('part_1', 'old')]);
        const entry = turnEntry(assistant);

        const next = buildLiveStreamingEntry(entry, {
            livePartsByMessageId: { assistant_other: [textPart('part_live', 'live')] },
            showTurnChangedFiles: false,
        });

        expect(next).toBe(entry);
    });

    test('rebuilds only the streaming turn with live parts', () => {
        const assistant = message('assistant_1', 'assistant', 'user_1', [textPart('part_1', 'hel')]);
        const entry = turnEntry(assistant);
        const liveParts = [reasoningPart('part_1_live', 'thinking')];

        const next = buildLiveStreamingEntry(entry, {
            livePartsByMessageId: { assistant_1: liveParts },
            showTurnChangedFiles: false,
        });

        expect(next).not.toBe(entry);
        expect(next.kind).toBe('turn');
        if (next.kind !== 'turn') return;
        expect(next.turn.assistantMessages[0]?.parts).toBe(liveParts);
        expect(next.turn.activityParts.length).toBeGreaterThan(0);
    });

    test('updates an ungrouped streaming message with live parts', () => {
        const stale = message('assistant_1', 'assistant', undefined, [textPart('part_1', 'old')]);
        const entry: StreamingTailEntry = {
            kind: 'ungrouped',
            key: 'msg:assistant_1',
            message: stale,
        };
        const liveParts = [textPart('part_1_live', 'live')];

        const next = buildLiveStreamingEntry(entry, {
            livePartsByMessageId: { assistant_1: liveParts },
            showTurnChangedFiles: false,
        });

        expect(next).not.toBe(entry);
        expect(next.kind).toBe('ungrouped');
        if (next.kind !== 'ungrouped') return;
        expect(next.message.parts).toBe(liveParts);
    });

    test('normalizes live tail parts with the display filtering path', () => {
        const stale = message('assistant_1', 'assistant', 'user_1', [textPart('part_1', 'old')]);
        const entry = turnEntry(stale);
        const visible = textPart('part_visible', 'visible');
        // v2 has no synthetic parts; a malformed record is what normalization
        // drops. SAFETY: the double assertion is the point — this fixture
        // stands for a part the server sent without a `type`.
        const malformed = { id: 'part_broken' } as unknown as Part;

        const next = buildLiveStreamingEntry(entry, {
            livePartsByMessageId: { assistant_1: [malformed, visible] },
            showTurnChangedFiles: false,
        });

        expect(next.kind).toBe('turn');
        if (next.kind !== 'turn') return;
        expect(next.turn.assistantMessages[0]?.parts).toEqual([visible]);
    });

    test('keeps a finished step message on its live parts after the stream moves on', () => {
        const finished = message('assistant_1', 'assistant', 'user_1', []);
        const streaming = message('assistant_2', 'assistant', 'user_1', []);
        const entry = turnEntry(finished);
        if (entry.kind !== 'turn') return;
        entry.turn.assistantMessageIds = ['assistant_1', 'assistant_2'];
        entry.turn.assistantMessages = [finished, streaming];
        const finishedLive = [textPart('part_tool_done', 'tool output')];
        const streamingLive = [textPart('part_streaming', 'streaming')];

        const next = buildLiveStreamingEntry(entry, {
            livePartsByMessageId: { assistant_1: finishedLive, assistant_2: streamingLive },
            showTurnChangedFiles: false,
        });

        expect(next.kind).toBe('turn');
        if (next.kind !== 'turn') return;
        expect(next.turn.assistantMessages[0]?.parts).toEqual(finishedLive);
        expect(next.turn.assistantMessages[1]?.parts).toEqual(streamingLive);
    });

    test('keeps a turn that a notice opened when the reply streams', () => {
        const notice: ChatMessageEntry = {
            info: { id: 'notice_1', sessionID: 'ses_1', role: 'system', time: { created: 1 }, text: 'Instructions updated' },
            parts: [],
        };
        const assistant = message('assistant_1', 'assistant', undefined, [textPart('part_1', 'hel')]);
        const entry = turnEntry(assistant);
        if (entry.kind !== 'turn') return;
        entry.turn = {
            ...entry.turn,
            turnId: 'notice_1',
            userMessageId: 'notice_1',
            userMessage: notice,
            messages: [notice, assistant].map((record, order) => ({ messageId: record.info.id, role: record.info.role, message: record, order })),
        };
        const liveParts = [reasoningPart('part_1_live', 'thinking')];

        const next = buildLiveStreamingEntry(entry, {
            livePartsByMessageId: { assistant_1: liveParts },
            showTurnChangedFiles: false,
        });

        expect(next.kind).toBe('turn');
        if (next.kind !== 'turn') return;
        expect(next.turn.turnId).toBe('notice_1');
        expect(next.turn.assistantMessages[0]?.parts).toBe(liveParts);
        expect(next.turn.activityParts.length).toBeGreaterThan(0);
    });

    test('never erases record parts with an empty live array', () => {
        const assistant = message('assistant_1', 'assistant', 'user_1', [textPart('part_1', 'kept')]);
        const entry = turnEntry(assistant);

        const next = buildLiveStreamingEntry(entry, {
            livePartsByMessageId: { assistant_1: [] },
            showTurnChangedFiles: false,
        });

        expect(next).toBe(entry);
    });
});

describe('buildLiveStreamingEntry reuse across publishes', () => {
    const options = (liveParts: Part[]) => ({
        livePartsByMessageId: { asst_1: liveParts },
        showTurnChangedFiles: false,
    });

    test('an unchanged record and live parts normalize to the same message object', () => {
        const record = message('asst_1', 'assistant', 'user_1', [textPart('p1', 'old')]);
        const entry: StreamingTailEntry = { kind: 'ungrouped', key: 'asst_1', message: record };
        const liveParts = [textPart('p1', 'new text')];

        const first = buildLiveStreamingEntry(entry, options(liveParts));
        const second = buildLiveStreamingEntry(entry, options(liveParts));
        expect(first.kind === 'ungrouped' && second.kind === 'ungrouped' && first.message === second.message).toBe(true);

        const changed = buildLiveStreamingEntry(entry, options([textPart('p1', 'newer text')]));
        expect(changed.kind === 'ungrouped' && first.kind === 'ungrouped' && changed.message !== first.message).toBe(true);
    });
});
