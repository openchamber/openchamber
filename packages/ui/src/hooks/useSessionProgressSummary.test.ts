import type { Message, Part } from '@opencode-ai/sdk/v2';
import { describe, expect, test } from 'bun:test';

import { buildSessionProgressTranscript, getActiveCommandSnapshot } from './useSessionProgressSummary';

const userMessage = (id: string): Message => ({
    id,
    sessionID: 'session-1',
    role: 'user',
    time: { created: 1 },
    agent: 'build',
    model: { providerID: 'provider-1', modelID: 'model-1' },
});

const assistantMessage = (id: string, parentID: string): Message => ({
    id,
    sessionID: 'session-1',
    role: 'assistant',
    time: { created: 2 },
    parentID,
    modelID: 'model-1',
    providerID: 'provider-1',
    mode: 'build',
    agent: 'build',
    path: { cwd: '/tmp/project', root: '/tmp/project' },
    cost: 0,
    tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
    },
});

const part = (value: Part): Part => value;

describe('buildSessionProgressTranscript', () => {
    test('includes the active user request and live reasoning/tool activity', () => {
        const user = userMessage('user-1');
        const assistant = assistantMessage('assistant-1', user.id);
        const parts = new Map<string, Part[]>([
            [user.id, [part({ id: 'user-part', sessionID: 'session-1', messageID: user.id, type: 'text', text: 'Fix the failing tests.' })]],
            [assistant.id, [
                part({ id: 'reasoning-part', sessionID: 'session-1', messageID: assistant.id, type: 'reasoning', text: 'Inspecting the test failure and the affected reducer.' , time: { start: 2 } }),
                part({ id: 'tool-part', sessionID: 'session-1', messageID: assistant.id, type: 'tool', callID: 'call-1', tool: 'bash', state: { status: 'running', input: { command: 'bun test packages/ui/src/hooks/useSessionProgressSummary.test.ts' }, time: { start: 3 } } }),
            ]],
        ]);

        const transcript = buildSessionProgressTranscript([user, assistant], (messageId) => parts.get(messageId) ?? []);

        expect(transcript).toContain('User:\nFix the failing tests.');
        expect(transcript).toContain('Reasoning: Inspecting the test failure');
        expect(transcript).toContain('Tool bash (running): bun test packages/ui/src/hooks/useSessionProgressSummary.test.ts');
    });

    test('preserves both the request and the newest activity when context is capped', () => {
        const user = userMessage('user-1');
        const assistant = assistantMessage('assistant-1', user.id);
        const longReasoningParts = Array.from({ length: 10 }, (_, index) => part({
            id: `reasoning-part-${index}`,
            sessionID: 'session-1',
            messageID: assistant.id,
            type: 'reasoning',
            text: 'a'.repeat(1_800),
            time: { start: index + 2 },
        }));
        const parts = new Map<string, Part[]>([
            [user.id, [part({ id: 'user-part', sessionID: 'session-1', messageID: user.id, type: 'text', text: 'Keep this request.' })]],
            [assistant.id, longReasoningParts],
        ]);

        const transcript = buildSessionProgressTranscript([user, assistant], (messageId) => parts.get(messageId) ?? []);

        expect(transcript).toContain('User:\nKeep this request.');
        expect(transcript).toContain('[middle of transcript omitted]');
        expect(transcript?.length).toBeLessThanOrEqual(12_050);
    });

    test('returns null when no message has progress parts', () => {
        expect(buildSessionProgressTranscript([userMessage('user-1')], () => [])).toBeNull();
    });

    test('starts at a newer user request when the assistant has not responded yet', () => {
        const previousUser = userMessage('user-1');
        const previousAssistant = assistantMessage('assistant-1', previousUser.id);
        const currentUser = userMessage('user-2');
        const parts = new Map<string, Part[]>([
            [previousUser.id, [part({ id: 'previous-user-part', sessionID: 'session-1', messageID: previousUser.id, type: 'text', text: 'Previous request.' })]],
            [previousAssistant.id, [part({ id: 'previous-assistant-part', sessionID: 'session-1', messageID: previousAssistant.id, type: 'text', text: 'Previous response.' })]],
            [currentUser.id, [part({ id: 'current-user-part', sessionID: 'session-1', messageID: currentUser.id, type: 'text', text: 'Current request.' })]],
        ]);

        const transcript = buildSessionProgressTranscript(
            [previousUser, previousAssistant, currentUser],
            (messageId) => parts.get(messageId) ?? [],
        );

        expect(transcript).toBe('User:\nCurrent request.');
    });
});

describe('getActiveCommandSnapshot', () => {
    test('finds the newest pending or running shell command and its description', () => {
        const user = userMessage('user-1');
        const assistant = assistantMessage('assistant-1', user.id);
        const parts = [
            part({ id: 'read-part', sessionID: 'session-1', messageID: assistant.id, type: 'tool', callID: 'call-read', tool: 'read', state: { status: 'running', input: {}, time: { start: 2 } } }),
            part({ id: 'bash-part', sessionID: 'session-1', messageID: assistant.id, type: 'tool', callID: 'call-bash', tool: 'bash', state: { status: 'pending', input: { command: 'bun test', description: 'Check the changed tests' }, raw: '' } }),
        ];

        const snapshot = getActiveCommandSnapshot([user, assistant], (messageId) => messageId === assistant.id ? parts : []);

        expect(snapshot?.tool).toBe('bash');
        expect(snapshot?.command).toBe('bun test');
        expect(snapshot?.description).toBe('Check the changed tests');
        expect(snapshot?.key).toContain('bash-part');
    });

    test('does not report completed commands as active', () => {
        const user = userMessage('user-1');
        const assistant = assistantMessage('assistant-1', user.id);
        const completed = part({
            id: 'bash-part',
            sessionID: 'session-1',
            messageID: assistant.id,
            type: 'tool',
            callID: 'call-bash',
            tool: 'bash',
            state: {
                status: 'completed',
                input: { command: 'bun test' },
                output: 'passed',
                title: 'bun test',
                metadata: {},
                time: { start: 2, end: 3 },
            },
        });

        expect(getActiveCommandSnapshot([user, assistant], () => [completed])).toBeNull();
    });

    test('ignores an unfinished command from a previous turn', () => {
        const previousUser = userMessage('user-1');
        const previousAssistant = assistantMessage('assistant-1', previousUser.id);
        const currentUser = userMessage('user-2');
        const previousCommand = part({
            id: 'old-bash-part',
            sessionID: 'session-1',
            messageID: previousAssistant.id,
            type: 'tool',
            callID: 'old-call',
            tool: 'bash',
            state: { status: 'running', input: { command: 'bun test' }, time: { start: 2 } },
        });

        expect(getActiveCommandSnapshot(
            [previousUser, previousAssistant, currentUser],
            (messageId) => messageId === previousAssistant.id ? [previousCommand] : [],
        )).toBeNull();
    });
});
