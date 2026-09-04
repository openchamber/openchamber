import { describe, expect, test } from 'bun:test';

import type { Message, Part } from '@opencode-ai/sdk/v2';

import { deriveMessageSpeedMetrics } from './messageSpeedMetrics';

const assistantMessage = (overrides: Partial<Message> = {}): Message => ({
    id: 'msg_1',
    sessionID: 'ses_1',
    role: 'assistant',
    time: { created: 1_000 },
    parentID: 'msg_0',
    modelID: 'model',
    providerID: 'provider',
    mode: 'build',
    path: { cwd: '/', root: '/' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
} as Message);

const textPart = (start: number, end: number): Part => ({
    id: `p_${start}`,
    sessionID: 'ses_1',
    messageID: 'msg_1',
    type: 'text',
    text: 'hello',
    time: { start, end },
} as unknown as Part);

const reasoningPart = (start: number, end: number): Part => ({
    id: `r_${start}`,
    sessionID: 'ses_1',
    messageID: 'msg_1',
    type: 'reasoning',
    text: 'thinking',
    time: { start, end },
} as unknown as Part);

const stepFinishPart = (output: number): Part => ({
    id: `sf_${output}`,
    sessionID: 'ses_1',
    messageID: 'msg_1',
    type: 'step-finish',
    reason: 'stop',
    cost: 0,
    tokens: { input: 0, output, reasoning: 0, cache: { read: 0, write: 0 } },
} as unknown as Part);

const toolPart = (): Part => ({
    id: 't_1',
    sessionID: 'ses_1',
    messageID: 'msg_1',
    type: 'tool',
    callID: 'c_1',
    tool: 'bash',
    state: { status: 'completed', input: {}, output: '', title: '', metadata: {}, time: { start: 5_000, end: 9_000 } },
} as unknown as Part);

describe('deriveMessageSpeedMetrics', () => {
    test('returns null when no part carries a streaming window', () => {
        const info = assistantMessage({ tokens: { input: 0, output: 100, reasoning: 0, cache: { read: 0, write: 0 } } } as Partial<Message>);
        expect(deriveMessageSpeedMetrics(info, [toolPart()])).toBeNull();
        expect(deriveMessageSpeedMetrics(info, [])).toBeNull();
    });

    test('returns null when there are no output tokens', () => {
        const info = assistantMessage();
        expect(deriveMessageSpeedMetrics(info, [textPart(2_000, 3_000)])).toBeNull();
    });

    test('computes rate and TTFT from a single streaming window', () => {
        const info = assistantMessage({ tokens: { input: 0, output: 250, reasoning: 0, cache: { read: 0, write: 0 } } } as Partial<Message>);
        const metrics = deriveMessageSpeedMetrics(info, [textPart(1_400, 2_400)]);
        expect(metrics).not.toBeNull();
        expect(metrics?.ttftMs).toBe(400);
        expect(metrics?.tokensPerSecond).toBeCloseTo(250, 5);
    });

    test('merges interleaved text and reasoning windows instead of double counting', () => {
        const info = assistantMessage({ tokens: { input: 0, output: 100, reasoning: 0, cache: { read: 0, write: 0 } } } as Partial<Message>);
        const metrics = deriveMessageSpeedMetrics(info, [
            reasoningPart(2_000, 4_000),
            textPart(3_000, 5_000),
        ]);
        // Overlap counted once: the union of the windows is 3s, not 4s.
        expect(metrics?.tokensPerSecond).toBeCloseTo(100 / 3, 5);
    });

    test('excludes tool-call waiting between steps from the decode window', () => {
        const info = assistantMessage({ tokens: { input: 0, output: 200, reasoning: 0, cache: { read: 0, write: 0 } } } as Partial<Message>);
        const metrics = deriveMessageSpeedMetrics(info, [
            textPart(2_000, 3_000),
            toolPart(),
            textPart(9_000, 10_000),
        ]);
        expect(metrics?.tokensPerSecond).toBeCloseTo(100, 5);
    });

    test('falls back to summed step-finish tokens when message usage is absent', () => {
        const info = assistantMessage();
        const metrics = deriveMessageSpeedMetrics(info, [
            textPart(2_000, 3_000),
            stepFinishPart(80),
            textPart(9_000, 10_000),
            stepFinishPart(120),
        ]);
        expect(metrics?.tokensPerSecond).toBeCloseTo(100, 5);
    });

    test('prefers message usage over step-finish tokens', () => {
        const info = assistantMessage({ tokens: { input: 0, output: 200, reasoning: 0, cache: { read: 0, write: 0 } } } as Partial<Message>);
        const metrics = deriveMessageSpeedMetrics(info, [
            textPart(2_000, 3_000),
            stepFinishPart(999),
        ]);
        expect(metrics?.tokensPerSecond).toBeCloseTo(200, 5);
    });

    test('omits TTFT when the first window precedes the created timestamp', () => {
        const info = assistantMessage({ tokens: { input: 0, output: 100, reasoning: 0, cache: { read: 0, write: 0 } } } as Partial<Message>);
        const metrics = deriveMessageSpeedMetrics(info, [textPart(500, 1_500)]);
        expect(metrics?.ttftMs).toBeUndefined();
        expect(metrics?.tokensPerSecond).toBeCloseTo(100, 5);
    });

    test('ignores still-streaming windows with no end', () => {
        const info = assistantMessage({ tokens: { input: 0, output: 100, reasoning: 0, cache: { read: 0, write: 0 } } } as Partial<Message>);
        const openPart = {
            id: 'p_open',
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'text',
            text: '…',
            time: { start: 2_000 },
        } as unknown as Part;
        expect(deriveMessageSpeedMetrics(info, [openPart])).toBeNull();
    });

    test('falls back to the full created→completed span when parts carry no timing', () => {
        const info = assistantMessage({
            time: { created: 1_000, completed: 3_000 },
            tokens: { input: 0, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
        } as Partial<Message>);
        const metrics = deriveMessageSpeedMetrics(info, [
            { id: 'p_1', sessionID: 'ses_1', messageID: 'msg_1', type: 'text', text: 'hello' } as unknown as Part,
        ]);
        expect(metrics?.tokensPerSecond).toBeCloseTo(50, 5);
        expect(metrics?.ttftMs).toBeUndefined();
    });

    test('returns null when neither part timing nor message span exists', () => {
        const info = assistantMessage({ tokens: { input: 0, output: 100, reasoning: 0, cache: { read: 0, write: 0 } } } as Partial<Message>);
        expect(deriveMessageSpeedMetrics(info, [
            { id: 'p_1', sessionID: 'ses_1', messageID: 'msg_1', type: 'text', text: 'hello' } as unknown as Part,
        ])).toBeNull();
    });
});
