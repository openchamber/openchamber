import { describe, expect, test } from 'bun:test';

import { getCanonicalToolName, getToolMetadata } from '@/lib/toolHelpers';
import {
    formatToolParamSummaryValue,
    isExpandableTool,
    isStandaloneTool,
    isStaticTool,
    shouldShowToolParamSummary,
} from './toolRenderUtils';

describe('toolRenderUtils', () => {
    test('keeps custom namespaced tools expandable with parameter summaries', () => {
        expect(isExpandableTool('myplugin_bash')).toBe(true);
        expect(shouldShowToolParamSummary('myplugin_bash')).toBe(true);
    });

    test('does not collapse dotted custom tools into built-in tool metadata', () => {
        expect(isExpandableTool('plugin.bash')).toBe(true);
        expect(shouldShowToolParamSummary('plugin.bash')).toBe(true);
        expect(getToolMetadata('plugin.bash').displayName).toBe('Plugin bash');
    });

    test('keeps only read and skill static (in-app navigation tools)', () => {
        expect(isStaticTool('read')).toBe(true);
        expect(isStaticTool('skill')).toBe(true);
        expect(isExpandableTool('read')).toBe(false);
        expect(isExpandableTool('skill')).toBe(false);
    });

    test('makes built-in content tools expandable via the common renderer', () => {
        for (const toolName of ['bash', 'edit', 'write', 'grep', 'glob', 'list', 'webfetch', 'websearch', 'todowrite', 'lsp', 'question']) {
            expect([toolName, isExpandableTool(toolName)]).toEqual([toolName, true]);
            expect([toolName, isStaticTool(toolName)]).toEqual([toolName, false]);
        }
    });

    test('keeps task as a standalone activity boundary', () => {
        expect(isStandaloneTool('task')).toBe(true);
        expect(isExpandableTool('task')).toBe(true);
        expect(isStaticTool('task')).toBe(false);
    });

    test('does not show param summaries on known built-in tools', () => {
        for (const toolName of ['read', 'bash', 'edit', 'task', 'grep', 'webfetch', 'lsp', 'skill']) {
            expect([toolName, shouldShowToolParamSummary(toolName)]).toEqual([toolName, false]);
        }
    });

    test('shows param summaries on unknown custom/plugin/MCP tools', () => {
        expect(shouldShowToolParamSummary('unknown_custom_tool')).toBe(true);
        expect(shouldShowToolParamSummary('web-reader_webReader')).toBe(true);
        expect(shouldShowToolParamSummary('plugin.bash')).toBe(true);
    });

    describe('formatToolParamSummaryValue', () => {
        test('truncates long strings to 30 chars with ellipsis', () => {
            const long = 'a'.repeat(50);
            expect(formatToolParamSummaryValue(long)).toBe('a'.repeat(30) + '...');
        });

        test('keeps short strings as-is', () => {
            expect(formatToolParamSummaryValue('short')).toBe('short');
        });

        test('stringifies numbers and booleans', () => {
            expect(formatToolParamSummaryValue(42)).toBe('42');
            expect(formatToolParamSummaryValue(true)).toBe('true');
            expect(formatToolParamSummaryValue(false)).toBe('false');
        });

        test('renders null as "null"', () => {
            expect(formatToolParamSummaryValue(null)).toBe('null');
        });

        test('serializes small objects as json', () => {
            expect(formatToolParamSummaryValue({ a: 1 })).toBe('{"a":1}');
        });

        test('truncates large objects with ellipsis', () => {
            const big = { edits: Array(20).fill({ oldString: 'a'.repeat(10) }) };
            const result = formatToolParamSummaryValue(big);
            expect(result.endsWith('...')).toBe(true);
            expect(result.length).toBe(33);
        });
    });

    describe('getCanonicalToolName', () => {
        test('lowercases and strips :N suffix', () => {
            expect(getCanonicalToolName('BASH:0')).toBe('bash');
            expect(getCanonicalToolName('Edit:3')).toBe('edit');
        });

        test('preserves dots in custom namespaced tools', () => {
            expect(getCanonicalToolName('plugin.bash')).toBe('plugin.bash');
            expect(getCanonicalToolName('mcp.server.tool:1')).toBe('mcp.server.tool');
        });

        test('returns empty string for non-string or empty input', () => {
            expect(getCanonicalToolName(undefined)).toBe('');
            expect(getCanonicalToolName(123 as unknown)).toBe('');
            expect(getCanonicalToolName('')).toBe('');
        });
    });
});
