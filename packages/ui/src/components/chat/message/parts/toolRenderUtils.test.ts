import { describe, expect, test } from 'bun:test';

import type { Part } from '@/lib/opencode/model';
import { collectFileChangeToolIds, isExpandableTool, isStaticTool } from './toolRenderUtils';

const toolPart = (id: string, tool: string): Part => ({
    id,
    sessionID: 'session',
    messageID: 'message',
    type: 'tool',
    callID: `call-${id}`,
    tool,
    state: { status: 'pending', input: {}, raw: '' },
});

const fileChangePart = (id: string, tool: 'write' | 'edit' | 'patch' = 'edit'): Part => toolPart(id, tool);

describe('tool rendering classification', () => {
    test('keeps navigation tools compact', () => {
        expect(isStaticTool('read')).toBe(true);
        expect(isStaticTool('skill')).toBe(true);
        expect(isExpandableTool('read')).toBe(false);
        expect(isExpandableTool('skill')).toBe(false);
    });

    test('expands built-in tools without direct navigation', () => {
        expect(isExpandableTool('grep')).toBe(true);
        expect(isExpandableTool('webfetch')).toBe(true);
        expect(isExpandableTool('bash')).toBe(true);
        expect(isExpandableTool('plan_exit')).toBe(true);
    });

    test('expands custom and MCP tools', () => {
        expect(isExpandableTool('linear_list_issues')).toBe(true);
        expect(isExpandableTool('my-plugin_publish')).toBe(true);
        expect(isStaticTool('linear_list_issues')).toBe(false);
    });

    test('normalizes dotted and indexed tool names', () => {
        expect(isStaticTool('runtime.read:2')).toBe(true);
        expect(isExpandableTool('runtime.custom_tool:2')).toBe(true);
    });
});

describe('collectFileChangeToolIds', () => {
    test('returns nothing when no tool call mutates a file', () => {
        expect(collectFileChangeToolIds([toolPart('a', 'read'), toolPart('b', 'shell')], Infinity)).toEqual([]);
    });

    test('takes the most recent file-change tools up to the limit, chronological', () => {
        const parts = [toolPart('a', 'read'), fileChangePart('b'), toolPart('c', 'shell'), fileChangePart('d'), fileChangePart('e')];
        expect(collectFileChangeToolIds(parts, 2)).toEqual(['d', 'e']);
        expect(collectFileChangeToolIds(parts, Infinity)).toEqual(['b', 'd', 'e']);
    });

    test('limits of zero collect nothing', () => {
        expect(collectFileChangeToolIds([fileChangePart('a'), fileChangePart('b')], 0)).toEqual([]);
    });

    test('keeps text and reasoning parts out of the result', () => {
        const textPart: Part = { id: 't', sessionID: 'session', messageID: 'message', type: 'text', text: 'hello' };
        const parts = [textPart, fileChangePart('b'), textPart];
        expect(collectFileChangeToolIds(parts, Infinity)).toEqual(['b']);
    });

    test('counts write, edit, and patch as file changes', () => {
        const parts = [fileChangePart('w', 'write'), fileChangePart('e', 'edit'), fileChangePart('p', 'patch')];
        expect(collectFileChangeToolIds(parts, Infinity)).toEqual(['w', 'e', 'p']);
    });
});
