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

    test('keeps built-in custom-rendered tools from showing duplicate parameter summaries', () => {
        expect(isExpandableTool('bash')).toBe(true);
        expect(shouldShowToolParamSummary('bash')).toBe(false);
    });

    test('keeps built-in custom-rendered aliases from showing duplicate parameter summaries', () => {
        const aliases = ['shell', 'cmd', 'terminal', 'create', 'file_write'];

        for (const toolName of aliases) {
            expect([toolName, isExpandableTool(toolName)]).toEqual([toolName, true]);
            expect([toolName, shouldShowToolParamSummary(toolName)]).toEqual([toolName, false]);
        }
    });

    test('keeps task as both an expandable tool and an activity group boundary', () => {
        expect(isExpandableTool('task')).toBe(true);
        expect(isStandaloneTool('task')).toBe(true);
        expect(isStaticTool('task')).toBe(false);
        expect(shouldShowToolParamSummary('task')).toBe(false);
    });

    test('keeps static built-in tools static without parameter summaries', () => {
        expect(isStaticTool('read')).toBe(true);
        expect(shouldShowToolParamSummary('read')).toBe(false);
    });

    test('keeps grep-family search tools static', () => {
        for (const toolName of ['grep', 'glob', 'search', 'find', 'ripgrep']) {
            expect([toolName, isStaticTool(toolName)]).toEqual([toolName, true]);
            expect([toolName, shouldShowToolParamSummary(toolName)]).toEqual([toolName, false]);
        }
    });

    test('keeps todo tools static without parameter summaries', () => {
        expect(isStaticTool('todowrite')).toBe(true);
        expect(isStaticTool('todoread')).toBe(true);
        expect(shouldShowToolParamSummary('todowrite')).toBe(false);
    });

    test('keeps known built-in metadata tools static unless explicitly marked otherwise', () => {
        const staticTools = [
            'list',
            'webfetch',
            'websearch',
            'codesearch',
            'skill',
            'plan_enter',
            'plan_exit',
            'StructuredOutput',
            'structuredoutput',
        ];

        for (const toolName of staticTools) {
            expect([toolName, isStaticTool(toolName)]).toEqual([toolName, true]);
            expect([toolName, isExpandableTool(toolName)]).toEqual([toolName, false]);
            expect([toolName, isStandaloneTool(toolName)]).toEqual([toolName, false]);
            expect([toolName, shouldShowToolParamSummary(toolName)]).toEqual([toolName, false]);
        }
    });

    test('keeps lsp expandable without duplicate parameter summaries', () => {
        expect(isExpandableTool('lsp')).toBe(true);
        expect(isStaticTool('lsp')).toBe(false);
        expect(shouldShowToolParamSummary('lsp')).toBe(false);
    });

    test('keeps unknown tools expandable with parameter summaries', () => {
        expect(isExpandableTool('unknown_custom_tool')).toBe(true);
        expect(isStaticTool('unknown_custom_tool')).toBe(false);
        expect(shouldShowToolParamSummary('unknown_custom_tool')).toBe(true);
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
