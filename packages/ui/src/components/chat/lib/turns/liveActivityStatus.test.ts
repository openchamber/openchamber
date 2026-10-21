import { describe, expect, test } from 'bun:test';

import type { Part, ToolPart } from '@/lib/opencode/model';

import { latestRunningTool } from './liveActivityStatus';

const text = (id: string, value: string): Part => ({ id, type: 'text', text: value, messageID: 'm', sessionID: 's' });

const tool = (id: string, toolName: string, state: ToolPart['state']): ToolPart => ({
    id, callID: id, type: 'tool', tool: toolName, messageID: 'm', sessionID: 's', state,
});

describe('latestRunningTool', () => {
    test('names the running shell command', () => {
        const result = latestRunningTool([
            text('t', 'Working'),
            tool('shell', 'shell', { status: 'running', input: { command: 'npm test\nnpm run build' }, time: { start: 1 } }),
        ]);
        expect(result).toEqual({ label: 'Shell Command', description: 'npm test' });
    });

    test('uses the latest running call when several overlap', () => {
        const result = latestRunningTool([
            tool('read', 'read', { status: 'running', input: { path: 'src/a.ts' }, time: { start: 1 } }),
            tool('shell', 'shell', { status: 'running', input: { command: 'pnpm check' }, time: { start: 2 } }),
        ]);
        expect(result).toEqual({ label: 'Shell Command', description: 'pnpm check' });
    });

    test('ignores completed calls and returns to plain Activity', () => {
        const result = latestRunningTool([
            tool('shell', 'shell', { status: 'completed', input: { command: 'npm test' }, output: '', metadata: {}, time: { start: 1, end: 2 } }),
        ]);
        expect(result).toBeNull();
    });

    test('describes an edit by its path', () => {
        const result = latestRunningTool([
            tool('edit', 'edit', { status: 'running', input: { path: 'src/a.ts' }, time: { start: 1 } }),
        ]);
        expect(result).toEqual({ label: 'Edit File', description: 'src/a.ts' });
    });
});
